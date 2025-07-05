## FITS Table Viewer for VS Code

FITS Table Viewer for VS Code

<p align="center">
<img src="https://raw.githubusercontent.com/tharvey303/fitstableview/main/resources/logo.png" alt="FITS Table Viewer Logo" width="128"/>
</p>

A powerful and flexible VS Code extension for viewing tabular data within FITS (Flexible Image Transport System) files. Built for astronomers, astrophysicists, and anyone working with astronomical data, this extension provides an interactive GUI to inspect FITS tables without leaving your editor.

This extension is a work in progress — suggestions, comments and pull requests welcome!

### Features

Interactive Table GUI: Opens FITS tables in a feature-rich, interactive viewer powered by Tabulator.

* HDU Selection: If a file contains multiple Header/Data Units (HDUs), the extension prompts you to select which tabular HDU you want to view.
* Large File Support: Efficiently streams data from the Python backend, allowing you to open and view tables that are too large to fit in memory.
* Context Menu Integration: Simply right-click on a .fits, .fit, or .fts file in the explorer and select "FITS Viewer: Open FITS File" to get started. You can also use the command palette (Ctrl+Shift+P) and search for "FITS Viewer: Open FITS File" to open a file, or enable the FITS viewer as the default handler for FITS files in the VS Code settings.
* Customizable Themes: Choose from several built-in display themes via the VS Code Settings page to customize the look of your table.
    
* Powerful Table Features:
    * Sort by any column.
    * Filter data with per-column header inputs.
    * Resize and reorder columns.
    * Virtual DOM - only renders visible rows and columns, improving performance with large datasets.


### Prerequisites

This extension acts as a graphical frontend and relies on a Python backend for data processing. Before using the extension, you must have the following installed in your Python environment:

1. Python 3: Ensure a Python 3 interpreter is installed and that VS Code is configured to use it. You can select your interpreter via the Python: Select Interpreter command in the Command Palette.

2. Required Libraries: The astropy and pandas libraries are required. You can install them using pip:

    ``` pip install astropy pandas ``` 

### Extension Settings

This extension contributes the following settings to the VS Code Settings UI:

* fits-viewer.theme: Allows you to select the display theme for the table viewer.
  * How to Change: Go to File > Preferences > Settings, search for "FITS Viewer", and select your preferred theme from the dropdown menu.

* fits-viewer.pagination.enabled: Enables or disables pagination in the table viewer.
  * How to Change: Go to File > Preferences > Settings, search for "FITS Viewer Pagination", and toggle the setting.

"fits-viewer.pagination.pageSize": Sets the number of rows per page when pagination is enabled.
  * How to Change: Go to File > Preferences > Settings, search for "FITS Viewer Pagination Page Size", and set your desired value.

* fits-viewer.maxRows: Limits the number of rows loaded into the viewer at once. Default is to load all rows, but this can be adjusted to improve performance with very large datasets.
  * How to Change: Go to File > Preferences > Settings, search for "FITS Viewer Max Rows", and set your desired value. 

* fits-viewer.maxColumns: Limits the number of columns loaded into the viewer at once. Default is to load all columns, but this can be adjusted to improve performance with very wide datasets.

### Known Issues

* Large datasets may take some time to load, especially if the file contains many rows or columns. They viewer may also become unresponsive. We are investigating ways to improve performance and responsiveness for large datasets. In the meantime, if you experience performance issues, consider adjusting the `fits-viewer.maxRows` and `fits-viewer.maxColumns` settings to limit the number of rows and columns loaded into the viewer at once. You can kill the backend process by using the command palette (Ctrl+Shift+P) and searching for "FITS Table Viewer: Terminate All Backend Processes" to stop the viewer from hanging.
* The viewer currently only supports tabular HDUs (BinTableHDU, TableHDU). Image HDUs are ignored.
* Column calculations and data export features are not yet implemented.
* Column metadata (e.g., units, descriptions) are not displayed in the viewer as they are not supported by Tabulator or pandas. 
* Multi-dimensional columns are currently converted to multiple columns, named colname_1, colname_2, etc. This may not be ideal for all use cases.


### Release Notes

0.3.0

* We now skip asking the user to select an HDU if the file only contains one tabular HDU.
* We added settings to allow users to select a theme for the table viewer. (Including a dark mode!)
* We also added settings to enable pagination, and limit the number of rows/columns loaded into the viewer.
* The viewer can now be registered as a file handler for .fits, .fit, and .fts files, allowing you to open these files directly in the viewer from the VS Code explorer.
* We added an output log to the viewer, which displays messages from the Python backend, including errors and warnings.
* We added a loading bar, and more informative progress messages for the user.
* Interrupted processes are now killed gracefully, preventing the viewer from hanging if a long-running operation is interrupted.
* We added a debug option  ```FITS Table Viewer: Terminate All Backend Processes```, which allows you to terminate all running backend processes from the command palette.

0.1.0

* Initial public release.
* Added state preservation to prevent tabs from reloading.
* Added a theme selection setting.

This project is licensed under the GNU GPL3 License - see the LICENSE.md file for details.

The table viewer is powered by [Tabulator](http://tabulator.info/), a powerful table library that provides a rich set of features for displaying and interacting with tabular data. The Python backend uses [Astropy](https://www.astropy.org/) for FITS file handling and [Pandas](https://pandas.pydata.org/) for data manipulation, ensuring efficient processing of large datasets.