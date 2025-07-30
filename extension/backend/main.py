import sys
import json
from pathlib import Path
import argparse

from astropy.io import fits
from astropy.table import Table

def fix_multi_dim_tables(table: Table) -> Table:
    """
    Fixes multi-dimensional columns by splitting them into separate columns
    """
    names = [name for name in table.colnames if len(table[name].shape) > 1]
    if len(names) > 0:
        for name in names:
            if len(table[name].shape) > 1:
                for i in range(table[name].shape[1]):
                    table[f"{name}_{i+1}"] = table[name][:, i]
                del table[name]
    return table

def get_hdu_info(file_path: str) -> str:
    """
    Inspects a FITS file and returns a JSON string with information
    about each HDU, noting which ones are tabular. (This function remains unchanged).
    """
    try:
        with fits.open(file_path) as hdul:
            hdu_info = []
            for i, hdu in enumerate(hdul):
                is_table = isinstance(hdu, (fits.BinTableHDU, fits.TableHDU))
                info = {
                    "index": i,
                    "name": hdu.name or f"HDU {i}",
                    "is_table": is_table,
                    "type": hdu.__class__.__name__
                }
                hdu_info.append(info)
            return json.dumps(hdu_info)
    except FileNotFoundError:
        return json.dumps({"error": f"File not found: {file_path}"})
    except Exception as e:
        return json.dumps({"error": f"Failed to read FITS file: {str(e)}"})

def stream_table_data(file_path: str, hdu_index: int, max_rows: int, max_cols: int, chunk_size: int = 500):
    """
    Reads and streams tabular data, including progress updates.
    """
    try:
        with fits.open(file_path) as hdul:
            if not (0 <= hdu_index < len(hdul)):
                raise ValueError(f"HDU index {hdu_index} is out of bounds.")

            hdu = hdul[hdu_index]
            if not isinstance(hdu, (fits.BinTableHDU, fits.TableHDU)):
                raise TypeError(f"HDU {hdu_index} ('{hdu.name}') is not a table HDU.")

            total_rows = len(hdu.data)
            total_cols = len(hdu.columns.names)
            
            rows_to_process = total_rows
            warning_message = None

            if max_rows > 0 and total_rows > max_rows:
                rows_to_process = max_rows
                warning_message = f"Warning: Displaying first {max_rows} of {total_rows} rows."

            column_names = hdu.columns.names
            if max_cols > 0 and total_cols > max_cols:
                column_names = hdu.columns.names[:max_cols]
                col_warning = f"Displaying first {max_cols} of {total_cols} columns."
                warning_message = f"{warning_message} {col_warning}" if warning_message else f"Warning: {col_warning}"

            if rows_to_process == 0:
                print(json.dumps({"schema": {"fields": []}, "data": [], "total_rows": 0}), flush=True)
                return

            # Send the schema first, including total rows for the progress bar
            temp_table = Table(hdu.data[0:1])[column_names]
            schema_df = fix_multi_dim_tables(temp_table).to_pandas()
            schema_json = schema_df.to_json(orient="table", index=False)
            parsed_schema = json.loads(schema_json)
            schema_only_message = {
                "schema": parsed_schema["schema"],
                "data": [],
                "warning": warning_message,
                "total_rows": rows_to_process
            }
            print(json.dumps(schema_only_message), flush=True)

            # Stream the data in chunks with progress updates
            rows_sent = 0
            for i in range(0, rows_to_process, chunk_size):
                end = min(i + chunk_size, rows_to_process)
                
                astropy_table_chunk = Table(hdu.data[i:end])[column_names]
                df_chunk = fix_multi_dim_tables(astropy_table_chunk).to_pandas()
                json_records = json.loads(df_chunk.to_json(orient="records", default_handler=str))
                
                rows_sent += len(json_records)

                # Wrap the data chunk in an object with progress info
                progress_message = {
                    "data": json_records,
                    "progress": rows_sent
                }
                
                print(json.dumps(progress_message), flush=True)

    except Exception as e:
        error_message = json.dumps({"error": str(e)})
        print(error_message, flush=True)
        sys.exit(1)

def main():
    """
    Main entry point for the script, now using argparse.
    """
    parser = argparse.ArgumentParser(description="FITS Table Viewer Backend")
    parser.add_argument("command", choices=["info", "data"], help="The command to execute.")
    parser.add_argument("file_path", type=str, help="Path to the FITS file.")
    parser.add_argument("hdu_index", type=int, nargs='?', help="0-based index of the HDU (for 'data' command).")
    parser.add_argument("--max-rows", type=int, default=0, help="Max rows to load (0 for all).")
    parser.add_argument("--max-cols", type=int, default=0, help="Max columns to load (0 for all).")
    
    args = parser.parse_args()

    if not Path(args.file_path).exists():
        print(json.dumps({"error": f"File does not exist at path: {args.file_path}"}), flush=True)
        sys.exit(1)

    if args.command == "info":
        print(get_hdu_info(args.file_path))
    elif args.command == "data":
        if args.hdu_index is None:
            print(json.dumps({"error": "HDU index is required for the 'data' command."}), flush=True)
            sys.exit(1)
        stream_table_data(args.file_path, args.hdu_index, args.max_rows, args.max_cols)

if __name__ == "__main__":
    main()