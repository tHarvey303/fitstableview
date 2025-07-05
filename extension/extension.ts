import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

// A set to keep track of all active FITS viewer panels
const activePanels = new Set<vscode.WebviewPanel>();

export function activate(context: vscode.ExtensionContext) {

    // Listen for changes in the configuration
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('fits-viewer.theme')) {
            // If the theme setting changed, update all active panels
            const newTheme = getTheme();
            for (const panel of activePanels) {
                panel.webview.postMessage({ command: 'update_theme', theme: newTheme });
            }
        }
        // Prompt user to reload if the default editor setting is changed
        if (e.affectsConfiguration('fits-viewer.defaultEditor')) {
            vscode.window.showInformationMessage('FITS Viewer default editor setting changed. Please reload the window for it to take effect.', 'Reload Now').then(selection => {
                if (selection === 'Reload Now') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        }
    }));

    // Register the on-demand command (for context menu and command palette)
    context.subscriptions.push(vscode.commands.registerCommand('fits-viewer.open', async (uri?: vscode.Uri) => {
        let filePath: string;
        if (uri) {
            filePath = uri.fsPath;
        } else {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select FITS File',
                filters: { 'FITS Files': ['fits', 'fit', 'fts'] }
            });
            if (!fileUris || fileUris.length === 0) { return; }
            filePath = fileUris[0].fsPath;
        }
        // Create a new panel and populate it
        const panel = createWebviewPanel(context, filePath, -1); // -1 indicates HDU is not yet chosen
        populateWebviewForFile(context, filePath, panel);
    }));

    // Register the Custom Editor Provider unconditionally.
    // The 'when' clause in package.json will control its activation.
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'fits-viewer.customEditor',
            new FitsEditorProvider(context),
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );
}

/**
 * The core logic that populates a webview panel with FITS data.
 * This is now shared between the command and the custom editor.
 */
async function populateWebviewForFile(context: vscode.ExtensionContext, filePath: string, panel: vscode.WebviewPanel) {
    try {
        const hduInfoJson = await getHduInfo(context, filePath);
        const parsedData: any = JSON.parse(hduInfoJson);

        if (parsedData && parsedData.error) {
            throw new Error(parsedData.error);
        }

        const hduInfo: any[] = parsedData;
        const tableHdus = hduInfo.filter(hdu => hdu.is_table);

        if (tableHdus.length === 0) {
            vscode.window.showInformationMessage('No tabular data found in this FITS file.');
            panel.webview.html = getWebviewContent(context, panel.webview, 'error', 'No tabular HDUs found.');
            return;
        }

        let selectedHdu: { hduIndex: number } | undefined;
        if (tableHdus.length === 1) {
            selectedHdu = { hduIndex: tableHdus[0].index };
        } else {
            const quickPickItems = tableHdus.map(hdu => ({
                label: `HDU ${hdu.index}: ${hdu.name}`,
                description: `Type: ${hdu.type}`,
                hduIndex: hdu.index
            }));
            const choice = await vscode.window.showQuickPick(quickPickItems, { placeHolder: 'Select a table HDU to view' });
            selectedHdu = choice;
        }

        if (!selectedHdu) {
            panel.webview.html = getWebviewContent(context, panel.webview, 'error', 'No HDU selected.');
            return;
        }

        // Update panel title now that we have the HDU index
        panel.title = `FITS: ${path.basename(filePath)} [HDU ${selectedHdu.hduIndex}]`;
        panel.webview.html = getWebviewContent(context, panel.webview);

        streamPythonData(context, filePath, selectedHdu.hduIndex,
            (chunk) => {
                try {
                    const data = JSON.parse(chunk);
                    if (data.error) {
                        panel.webview.postMessage({ command: 'error', message: data.error });
                    } else {
                        panel.webview.postMessage({ command: 'stream_data', data: data });
                    }
                } catch (e: any) {
                    console.error("Failed to parse JSON chunk: ", chunk);
                }
            },
            (error) => {
                panel.webview.postMessage({ command: 'error', message: error.message });
            }
        );
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to open FITS viewer: ${error.message}`);
        panel.webview.html = getWebviewContent(context, panel.webview, 'error', error.message);
    }
}

/**
 * Provider for the FITS custom editor.
 */
class FitsEditorProvider implements vscode.CustomReadonlyEditorProvider {
    constructor(private readonly context: vscode.ExtensionContext) { }

    public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => { } };
    }

    public async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // Setup webview options
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'extension', 'webview'),
                vscode.Uri.joinPath(this.context.extensionUri, 'out')
            ]
        };

        // Add to active panels for theme updates
        activePanels.add(webviewPanel);
        webviewPanel.onDidDispose(() => {
            activePanels.delete(webviewPanel);
        });

        // Populate the webview with the FITS data
        populateWebviewForFile(this.context, document.uri.fsPath, webviewPanel);
    }
}

// Helper functions (createWebviewPanel, getWebviewContent, etc.) remain below
// Note: createWebviewPanel is now only used by the command, not the custom editor.
function createWebviewPanel(context: vscode.ExtensionContext, filePath: string, hduIndex: number): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'fitsTableView', `FITS: ${path.basename(filePath)}`, vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview'),
                vscode.Uri.joinPath(context.extensionUri, 'out')
            ]
        }
    );
    activePanels.add(panel);
    panel.onDidDispose(() => { activePanels.delete(panel); });
    panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'light-icon.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'dark-icon.svg')
    };
    return panel;
}

function getWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview, initialState: 'loading' | 'error' = 'loading', errorMessage: string = ''): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview', 'styles.css'));
    const tabulatorScriptUri = 'https://unpkg.com/tabulator-tables@5.5.4/dist/js/tabulator.min.js';
    const themeFileName = getTheme();
    const tabulatorStyleUri = `https://unpkg.com/tabulator-tables@5.5.4/dist/css/${themeFileName}`;
    const nonce = getNonce();

    let body = `<div id="table-container"></div><div id="status-bar">Loading...</div>`;
    if (initialState === 'error') {
        body = `<div class="status-container error"><h2>Error</h2><p>${errorMessage}</p></div>`;
    }

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://unpkg.com; script-src 'nonce-${nonce}' https://unpkg.com;"><link id="tabulator-theme" href="${tabulatorStyleUri}" rel="stylesheet"><link href="${styleUri}" rel="stylesheet"><title>FITS Table View</title></head><body>${body}<script nonce="${nonce}" src="${tabulatorScriptUri}"></script><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function getTheme(): string {
    return vscode.workspace.getConfiguration('fits-viewer').get<string>('theme', 'tabulator.min.css');
}

function getHduInfo(context: vscode.ExtensionContext, filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(context.extensionPath, 'extension', 'backend', 'main.py');
        const args = [scriptPath, 'info', filePath];
        const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', 'python');
        const pyProcess = spawn(pythonPath, args);
        let stdout = '';
        let stderr = '';
        pyProcess.stdout.on('data', (data) => { stdout += data.toString(); });
        pyProcess.stderr.on('data', (data) => { stderr += data.toString(); });
        pyProcess.on('close', (code) => {
            if (code !== 0) { return reject(new Error(stderr || `Python script failed with code ${code}`)); }
            resolve(stdout);
        });
        pyProcess.on('error', (err) => { reject(err); });
    });
}

function streamPythonData(context: vscode.ExtensionContext, filePath: string, hduIndex: number, onData: (chunk: string) => void, onError: (error: Error) => void) {
    const scriptPath = path.join(context.extensionPath, 'extension', 'backend', 'main.py');
    const args = [scriptPath, 'data', filePath, hduIndex.toString()];
    const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath', 'python');
    const pyProcess = spawn(pythonPath, args);
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
        if (code !== 0) { onError(new Error(stderr || `Python script failed with code ${code}`)); }
    });
    pyProcess.on('error', (err) => { onError(err); });
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function deactivate() {}
