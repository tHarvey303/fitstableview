// Make the Tabulator constructor available in the global scope
declare const Tabulator: any;

interface VsCodeApi {
  getState: () => any;
  setState: (newState: any) => void;
  postMessage: (message: any) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

(function () {
  const vscode = acquireVsCodeApi();
  let table: any = null; // To hold the Tabulator instance
  let allData: object[] = []; // To store all data rows received
  let schemaFields: { name: string }[] = [];
  const statusBar = document.getElementById('status-bar');

  // Restore state if it exists
  const previousState = vscode.getState();
  if (previousState && previousState.allData && previousState.schemaFields) {
      allData = previousState.allData;
      schemaFields = previousState.schemaFields;
      // If we have old data, render it immediately
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
      // First chunk is the schema, so initialize the table
      const tableContainer = document.getElementById('table-container');
      if (tableContainer) {
        schemaFields = data.schema.fields;
        initializeTable(tableContainer, schemaFields);
        vscode.setState({ allData, schemaFields }); // Save initial state
      }
    } else if (table && Array.isArray(data)) {
      // Subsequent chunks are arrays of row data
      table.addData(data).catch((err: any) => {
        console.error("Error adding data to Tabulator: ", err);
      });
      allData.push(...data); // Add to our master list
      if (statusBar) {
        statusBar.textContent = `Loaded ${allData.length} rows...`;
      }
      vscode.setState({ allData, schemaFields }); // Persist the new state
    }
  }

  function initializeTable(container: HTMLElement, fields: { name: string }[]) {
    const columnDefinitions = fields.map(field => ({
        title: field.name,
        field: field.name,
        headerFilter: "input",
        headerSort: true,
        resizable: true,
        formatter: (cell: any) => {
            const value = cell.getValue();
            if (typeof value === 'number' && !Number.isInteger(value)) {
                return value.toPrecision(6);
            }
            return value;
        }
    }));

    table = new Tabulator(container, {
      columns: columnDefinitions,
      layout: "fitData",
      height: "calc(100% - 25px)",
      placeholder: "Waiting for data...",
      virtualDom: true,
      movableColumns: true,
    });
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
  }
}());
