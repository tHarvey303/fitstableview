import * as vscode from 'vscode';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

// A dedicated output channel for logging
let outputChannel: vscode.OutputChannel;

// A set to keep track of all active FITS viewer panels
const activePanels = new Set<vscode.WebviewPanel>();
// A map to associate a panel with its data-providing Python process
const panelToProcessMap = new Map<vscode.WebviewPanel, ChildProcess>();

// Define a custom QuickPickItem to ensure type safety
interface HduQuickPickItem extends vscode.QuickPickItem {
    hduIndex: number;
}

/**
 * A simple logging utility to write messages to our output channel.
 * @param message The message to log.
 */
function log(message: string) {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Create the output channel for logging
    outputChannel = vscode.window.createOutputChannel("FITS Viewer");
    log("FITS Viewer extension is now active.");

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('fits-viewer.theme')) {
            log("Theme configuration changed. Updating active panels.");
            const newTheme = getTheme();
            for (const panel of activePanels) {
                panel.webview.postMessage({ command: 'update_theme', theme: newTheme });
            }
        }
        if (e.affectsConfiguration('fits-viewer.defaultEditor') || e.affectsConfiguration('fits-viewer.pagination') || e.affectsConfiguration('fits-viewer.maxRows') || e.affectsConfiguration('fits-viewer.maxColumns')) {
            log("A critical setting changed. Prompting user to reload.");
            vscode.window.showInformationMessage('FITS Viewer setting changed. Please reload the window for it to take full effect.', 'Reload Now').then(selection => {
                if (selection === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    }));

    // Register the command to open a file on-demand
    context.subscriptions.push(vscode.commands.registerCommand('fits-viewer.open', async (uri?: vscode.Uri) => {
        log(`Command 'fits-viewer.open' triggered for URI: ${uri ? uri.fsPath : '(from command palette)'}`);
        let filePath: string;
        if (uri) {
            filePath = uri.fsPath;
        } else {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false, openLabel: 'Select FITS File', filters: { 'FITS Files': ['fits', 'fit', 'fts'] }
            });
            if (!fileUris || fileUris.length === 0) { 
                log("File selection cancelled by user.");
                return; 
            }
            filePath = fileUris[0].fsPath;
        }
        const panel = createWebviewPanel(context, filePath, -1);
        populateWebviewForFile(context, filePath, panel);
    }));

    // Register the new command to terminate all backend processes
    context.subscriptions.push(vscode.commands.registerCommand('fits-viewer.killBackendProcesses', () => {
        log("Command 'fits-viewer.killBackendProcesses' triggered.");
        const panelCount = activePanels.size;
        const panelsToDispose = Array.from(activePanels);
        panelsToDispose.forEach(panel => {
            panel.dispose();
        });
        if (panelCount > 0) {
            vscode.window.showInformationMessage(`${panelCount} FITS Viewer instance(s) and their backend processes have been terminated.`);
        } else {
            vscode.window.showInformationMessage(`No active FITS Viewer instances to terminate.`);
        }
    }));

    // Register the Custom Editor Provider if the setting is enabled
    if (vscode.workspace.getConfiguration('fits-viewer').get<boolean>('defaultEditor')) {
        log("Registering FITS Viewer as the default editor.");
        context.subscriptions.push(
            vscode.window.registerCustomEditorProvider('fits-viewer.customEditor', new FitsEditorProvider(context), {
                webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false,
            })
        );
    }
}

async function populateWebviewForFile(context: vscode.ExtensionContext, filePath: string, panel: vscode.WebviewPanel) {
    log(`Populating webview for: ${filePath}`);
    try {
        panel.webview.html = getWebviewContent(context, panel.webview, 'loading', 'Inspecting FITS file...');

        const hduInfoJson = await getHduInfo(context, filePath);
        const parsedData: any = JSON.parse(hduInfoJson);
        if (parsedData && parsedData.error) { throw new Error(parsedData.error); }

        const tableHdus = parsedData.filter((hdu: any) => hdu.is_table);
        log(`Found ${tableHdus.length} table HDU(s).`);
        if (tableHdus.length === 0) {
            panel.webview.html = getWebviewContent(context, panel.webview, 'error', 'No tabular HDUs found.');
            return;
        }

        let selectedHdu: { hduIndex: number } | undefined;
        if (tableHdus.length === 1) {
            selectedHdu = { hduIndex: tableHdus[0].index };
            log(`Automatically selected the only table HDU: ${selectedHdu.hduIndex}`);
        } else {
            const quickPickItems: HduQuickPickItem[] = tableHdus.map((hdu: any) => ({
                label: `HDU ${hdu.index}: ${hdu.name}`,
                description: `Type: ${hdu.type}`,
                hduIndex: hdu.index
            }));
            const choice = await vscode.window.showQuickPick(quickPickItems, { placeHolder: 'Select a table HDU to view' });
            selectedHdu = choice;
        }

        if (!selectedHdu) {
            log("HDU selection cancelled by user.");
            panel.dispose();
            return;
        }
        log(`User selected HDU ${selectedHdu.hduIndex}.`);

        panel.title = `FITS: ${path.basename(filePath)} [HDU ${selectedHdu.hduIndex}]`;
        panel.webview.html = getWebviewContent(context, panel.webview, 'loading', 'Loading table data...');

        const config = vscode.workspace.getConfiguration('fits-viewer');
        const maxRows = config.get<number>('maxRows', 0);
        const maxColumns = config.get<number>('maxColumns', 0);

        const pyProcess = streamPythonData(context, filePath, selectedHdu.hduIndex, maxRows, maxColumns,
            (chunk) => {
                if (!panel.webview) return;
                try {
                    const data = JSON.parse(chunk);
                    log(`Relaying data chunk to webview.`);
                    if (data.error) {
                        panel.webview.postMessage({ command: 'error', message: data.error });
                    } else {
                        panel.webview.postMessage({ command: 'stream_data', data: data });
                    }
                } catch (e: any) { log(`ERROR: Failed to parse JSON chunk: ${chunk}`); }
            },
            (error) => {
                if (!panel.webview) return;
                panel.webview.postMessage({ command: 'error', message: error.message });
            }
        );
        
        panelToProcessMap.set(panel, pyProcess);

    } catch (error: any) {
        log(`ERROR during webview population: ${error.message}`);
        vscode.window.showErrorMessage(`Failed to open FITS viewer: ${error.message}`);
        if (panel && panel.webview) {
            panel.webview.html = getWebviewContent(context, panel.webview, 'error', error.message);
        }
    }
}

class FitsEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) { }
    public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument { return { uri, dispose: () => { } }; }
    public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        log(`Resolving custom editor for: ${document.uri.fsPath}`);
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'extension', 'webview'), vscode.Uri.joinPath(this.context.extensionUri, 'out')]
        };
        addPanel(webviewPanel);
        populateWebviewForFile(this.context, document.uri.fsPath, webviewPanel);
    }
}

function createWebviewPanel(context: vscode.ExtensionContext, filePath: string, hduIndex: number): vscode.WebviewPanel {
    log(`Creating new webview panel for: ${filePath}`);
    const panel = vscode.window.createWebviewPanel('fitsTableView', `FITS: ${path.basename(filePath)}`, vscode.ViewColumn.One, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview'), vscode.Uri.joinPath(context.extensionUri, 'out')]
    });
    addPanel(panel);
    panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'light-icon.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'dark-icon.svg')
    };
    return panel;
}

function addPanel(panel: vscode.WebviewPanel) {
    activePanels.add(panel);
    panel.onDidDispose(() => {
        log("Webview panel closed.");
        const process = panelToProcessMap.get(panel);
        if (process && !process.killed) {
            log(`Terminating Python process (PID: ${process.pid}) for closed panel.`);
            process.kill();
        }
        panelToProcessMap.delete(panel);
        activePanels.delete(panel);
    });
}

function getWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview, initialState: 'loading' | 'error' = 'loading', message: string = 'Loading...'): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview', 'styles.css'));
    const tabulatorScriptUri = 'https://unpkg.com/tabulator-tables@5.5.4/dist/js/tabulator.min.js';
    const themeFileName = getTheme();
    const tabulatorStyleUri = `https://unpkg.com/tabulator-tables@5.5.4/dist/css/${themeFileName}`;
    const nonce = getNonce();

    const config = vscode.workspace.getConfiguration('fits-viewer.pagination');
    const paginationSettings = {
        enabled: config.get<boolean>('enabled', false),
        pageSize: config.get<number>('pageSize', 50)
    };

    let body = `
        <div id="progress-container" class="hidden">
            <div id="progress-bar"></div>
        </div>
        <div id="table-container"></div>
        <div id="status-bar">${message}</div>
    `;
    if (initialState === 'error') {
        body = `<div class="status-container error"><h2>Error</h2><p>${message}</p></div>`;
    }

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://unpkg.com; script-src 'nonce-${nonce}' 'unsafe-inline';"><link id="tabulator-theme" href="${tabulatorStyleUri}" rel="stylesheet"><link href="${styleUri}" rel="stylesheet"><title>FITS Table View</title></head><body>${body}<script nonce="${nonce}">const paginationSettings = ${JSON.stringify(paginationSettings)};</script><script nonce="${nonce}" src="${tabulatorScriptUri}"></script><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function getTheme(): string { return vscode.workspace.getConfiguration('fits-viewer').get<string>('theme', 'tabulator.min.css'); }

function getHduInfo(context: vscode.ExtensionContext, filePath: string): Promise<string> {
    const TIMEOUT = 15000; // 15 seconds

    return new Promise((resolve, reject) => {
        const scriptPath = path.join(context.extensionPath, 'extension', 'backend', 'main.py');
        const args = [scriptPath, 'info', filePath];
        const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', 'python');
        log(`Spawning Python for HDU info: ${pythonPath} ${args.join(' ')}`);
        const pyProcess = spawn(pythonPath, args);

        const timeoutId = setTimeout(() => {
            if (!pyProcess.killed) {
                log(`ERROR: HDU info process (PID: ${pyProcess.pid}) timed out.`);
                pyProcess.kill();
                reject(new Error(`Timeout: FITS header inspection took longer than ${TIMEOUT / 1000} seconds.`));
            }
        }, TIMEOUT);

        let stdout = ''; let stderr = '';
        pyProcess.stdout.on('data', (data) => { stdout += data.toString(); });
        pyProcess.stderr.on('data', (data) => { stderr += data.toString(); });
        
        pyProcess.on('close', (code) => {
            clearTimeout(timeoutId);
            log(`HDU info process (PID: ${pyProcess.pid}) finished with code ${code}.`);
            if (code !== 0) { return reject(new Error(stderr || `Python script failed`)); }
            resolve(stdout);
        });
        
        pyProcess.on('error', (err) => {
            clearTimeout(timeoutId);
            log(`ERROR: Failed to spawn HDU info process: ${err.message}`);
            reject(err);
        });
    });
}

function streamPythonData(context: vscode.ExtensionContext, filePath: string, hduIndex: number, maxRows: number, maxCols: number, onData: (chunk: string) => void, onError: (error: Error) => void): ChildProcess {
    const scriptPath = path.join(context.extensionPath, 'extension', 'backend', 'main.py');
    const args = [
        scriptPath, 'data', filePath, hduIndex.toString(),
        '--max-rows', maxRows.toString(),
        '--max-cols', maxCols.toString()
    ];
    const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', 'python');
    log(`Spawning Python for data stream: ${pythonPath} ${args.join(' ')}`);
    const pyProcess = spawn(pythonPath, args);
    
    pyProcess.on('error', (err) => { 
        log(`ERROR: Failed to spawn data stream process: ${err.message}`);
        onError(err); 
    });

    let buffer = '';
    pyProcess.stdout.on('data', (data) => {
        buffer += data.toString();
        let boundary = buffer.indexOf('\n');
        while (boundary !== -1) {
            const line = buffer.substring(0, boundary);
            buffer = buffer.substring(boundary + 1);
            if (line) { onData(line); }
            boundary = buffer.indexOf('\n');
        }
    });

    let stderr = '';
    pyProcess.stderr.on('data', (data) => { stderr += data.toString(); });
    
    pyProcess.on('close', (code) => { 
        log(`Data stream process (PID: ${pyProcess.pid}) finished with code ${code}.`);
        if (code !== 0) { onError(new Error(stderr || `Python script failed`)); } 
    });
    
    return pyProcess;
}

function getNonce(): string { let text = ''; const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); } return text; }
export function deactivate() {
    log("FITS Viewer extension is deactivating. Terminating all processes.");
    const panelsToDispose = Array.from(activePanels);
    panelsToDispose.forEach(panel => panel.dispose());
}
