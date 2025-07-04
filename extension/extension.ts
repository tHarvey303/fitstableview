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
    }));

    let disposable = vscode.commands.registerCommand('fits-viewer.open', async (uri?: vscode.Uri) => {
        let filePath: string;

        if (uri) {
            filePath = uri.fsPath;
        } else {
            const fileUris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                openLabel: 'Select FITS File',
                filters: { 'FITS Files': ['fits', 'fit', 'fts'] }
            });

            if (!fileUris || fileUris.length === 0) {
                vscode.window.showInformationMessage('No file selected.');
                return;
            }
            filePath = fileUris[0].fsPath;
        }


        try {
            const hduInfoJson = await getHduInfo(context, filePath);
            const parsedData: any = JSON.parse(hduInfoJson);

            if (parsedData && parsedData.error) {
                vscode.window.showErrorMessage(`Error reading FITS file: ${parsedData.error}`);
                return;
            }

            const hduInfo: any[] = parsedData;
            const tableHdus = hduInfo.filter(hdu => hdu.is_table);

            if (tableHdus.length === 0) {
                vscode.window.showInformationMessage('No tabular data found in this FITS file.');
                return;
            }

            const quickPickItems = tableHdus.map(hdu => ({
                label: `HDU ${hdu.index}: ${hdu.name}`,
                description: `Type: ${hdu.type}`,
                hduIndex: hdu.index
            }));

            const selectedHdu = await vscode.window.showQuickPick(quickPickItems, {
                placeHolder: 'Select a table HDU to view'
            });

            if (!selectedHdu) { return; }

            const panel = createWebviewPanel(context, filePath, selectedHdu.hduIndex);

            streamPythonData(
                context,
                filePath,
                selectedHdu.hduIndex,
                (chunk) => {
                    try {
                        const data = JSON.parse(chunk);
                        if (data.error) {
                            vscode.window.showErrorMessage(`Error streaming data: ${data.error}`);
                            panel.webview.postMessage({ command: 'error', message: data.error });
                        } else {
                            panel.webview.postMessage({ command: 'stream_data', data: data });
                        }
                    } catch (e: any) {
                        console.error("Failed to parse JSON chunk: ", chunk);
                        vscode.window.showErrorMessage(`Failed to parse data chunk: ${e.message}`);
                    }
                },
                (error) => {
                    vscode.window.showErrorMessage(`Python script error: ${error.message}`);
                    panel.webview.postMessage({ command: 'error', message: error.message });
                }
            );

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to inspect FITS file: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

function createWebviewPanel(context: vscode.ExtensionContext, filePath: string, hduIndex: number): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
        'fitsTableView', 'FITS: ' + path.basename(filePath) + ` [HDU ${hduIndex}]`, vscode.ViewColumn.One,
        {
            enableScripts: true,
            // This is the key change: it keeps the webview's content in memory when hidden.
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview'),
                vscode.Uri.joinPath(context.extensionUri, 'out')
            ]
        }
    );

    // Add the panel to our set of active panels
    activePanels.add(panel);

    // When the panel is closed, remove it from the set
    panel.onDidDispose(() => {
        activePanels.delete(panel);
    });

    panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, 'resources', 'light-icon.svg'),
        dark: vscode.Uri.joinPath(context.extensionUri, 'resources', 'dark-icon.svg')
    };

    panel.webview.html = getWebviewContent(context, panel.webview);
    return panel;
}

function getWebviewContent(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'extension', 'webview', 'styles.css'));
    const tabulatorScriptUri = 'https://unpkg.com/tabulator-tables@5.5.4/dist/js/tabulator.min.js';
    
    // Read the theme from the user's settings
    const themeFileName = getTheme();
    const tabulatorStyleUri = `https://unpkg.com/tabulator-tables@5.5.4/dist/css/${themeFileName}`;

    const nonce = getNonce();

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://unpkg.com; script-src 'nonce-${nonce}' https://unpkg.com;">
            
            <link id="tabulator-theme" href="${tabulatorStyleUri}" rel="stylesheet">
            <link href="${styleUri}" rel="stylesheet">
            
            <title>FITS Table View</title>
        </head>
        <body>
            <div id="table-container"></div><div id="status-bar">Loading...</div>
            <script nonce="${nonce}" src="${tabulatorScriptUri}"></script>
            <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
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
            if (code !== 0) {
                return reject(new Error(stderr || `Python script failed with code ${code}`));
            }
            resolve(stdout);
        });
        pyProcess.on('error', (err) => { reject(err); });
    });
}

function streamPythonData(
    context: vscode.ExtensionContext,
    filePath: string,
    hduIndex: number,
    onData: (chunk: string) => void,
    onError: (error: Error) => void
) {
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
            if (line) {
                onData(line);
            }
            boundary = buffer.indexOf('\n');
        }
    });

    let stderr = '';
    pyProcess.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    pyProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`Python script exited with code ${code}`);
            console.error('Stderr:', stderr);
            onError(new Error(stderr || `Python script failed with code ${code}`));
        }
    });

    pyProcess.on('error', (err) => {
        onError(err);
    });
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
