// Make the Tabulator constructor and settings available
declare const Tabulator: any;
declare const paginationSettings: { enabled: boolean; pageSize: number; };

interface VsCodeApi {
  getState: () => any;
  setState: (newState: any) => void;
  postMessage: (message: any) => void;
}
declare function acquireVsCodeApi(): VsCodeApi;

(function () {
  const vscode = acquireVsCodeApi();
  let table: any = null;
  let allData: object[] = [];
  let schemaFields: { name: string }[] = [];
  let totalRows = 0; // To store the total number of rows to be loaded

  const statusBar = document.getElementById('status-bar');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');

  // Restore state if it exists
  const previousState = vscode.getState();
  if (previousState && previousState.allData && previousState.schemaFields) {
      allData = previousState.allData;
      schemaFields = previousState.schemaFields;
      const tableContainer = document.getElementById('table-container');
      if (tableContainer) {
          initializeTable(tableContainer, schemaFields);
          table.setData(allData);
          if (statusBar) {
            statusBar.textContent = `Restored ${allData.length} rows.`;
          }
      }
  }

  // Handle messages sent from the extension
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
      case 'stream_data':
        handleStreamedData(message.data);
        break;
      case 'update_theme':
        updateTheme(message.theme);
        break;
      case 'error':
        handleError(message.message);
        break;
    }
  });

  function updateTheme(themeFileName: string) {
      const themeLink = document.getElementById('tabulator-theme') as HTMLLinkElement;
      if (themeLink) {
          themeLink.href = `https://unpkg.com/tabulator-tables@5.5.4/dist/css/${themeFileName}`;
      }
  }

  function handleStreamedData(data: any) {
    if (!table && data.schema) {
      // First chunk is the schema, so initialize the table and progress bar
      const tableContainer = document.getElementById('table-container');
      if (tableContainer) {
        schemaFields = data.schema.fields;
        totalRows = data.total_rows || 0; // Get total rows for progress calculation
        initializeTable(tableContainer, schemaFields);
        vscode.setState({ allData, schemaFields });

        if (progressContainer && totalRows > 0) {
            progressContainer.classList.remove('hidden'); // Show the progress bar
        }

        if (data.warning && statusBar) {
            statusBar.textContent = data.warning;
        }
      }
    } else if (table && data.data) {
      // Subsequent chunks contain data and progress
      table.addData(data.data).catch((err: any) => { console.error("Error adding data: ", err); });
      allData.push(...data.data);

      if (statusBar && !statusBar.textContent?.startsWith("Warning")) {
        statusBar.textContent = `Loaded ${allData.length} of ${totalRows} rows...`;
      }

      // Update progress bar
      if (progressBar && totalRows > 0) {
          const percentComplete = (data.progress / totalRows) * 100;
          progressBar.style.width = `${percentComplete}%`;

          // Hide progress bar shortly after completion
          if (data.progress >= totalRows) {
              setTimeout(() => {
                  if(progressContainer) progressContainer.classList.add('hidden');
              }, 500);
          }
      }

      vscode.setState({ allData, schemaFields });
    }
  }

  function initializeTable(container: HTMLElement, fields: { name: string }[]) {
    const columnDefinitions = fields.map(field => ({
        title: field.name, field: field.name, headerFilter: "input", headerSort: true, resizable: true,
        formatter: (cell: any) => {
            const value = cell.getValue();
            if (typeof value === 'number' && !Number.isInteger(value)) { return value.toPrecision(6); }
            return value;
        }
    }));

    const tableConfig: any = {
      columns: columnDefinitions,
      layout: "fitData",
      height: "calc(100% - 29px)", // Adjust for status bar and progress bar
      placeholder: "Waiting for data...",
      virtualDom: !paginationSettings.enabled,
      virtualDomHoz: true,
      movableColumns: true,
    };

    if (paginationSettings.enabled) {
        tableConfig.pagination = true;
        tableConfig.paginationSize = paginationSettings.pageSize;
        tableConfig.paginationMode = "local";
    }

    table = new Tabulator(container, tableConfig);
  }

  function handleError(message: string) {
    const tableContainer = document.getElementById('table-container');
    if (tableContainer) {
        tableContainer.innerHTML = `<div class="status-container error"><h2>Error</h2><p>${message}</p></div>`;
    }
    if (statusBar) {
        statusBar.textContent = "Error";
        statusBar.style.backgroundColor = "var(--vscode-errorForeground)";
        statusBar.style.color = "var(--vscode-editor-background)";
    }
    if(progressContainer) {
        progressContainer.classList.add('hidden');
    }
  }
}());
