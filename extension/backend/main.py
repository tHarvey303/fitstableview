import sys
import json
from pathlib import Path

import pandas as pd
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

def stream_table_data(file_path: str, hdu_index: int, chunk_size: int = 1000):
    """
    Reads tabular data from a specific HDU in a FITS file and streams
    it to standard output in JSON chunks.

    Args:
        file_path: The full path to the FITS file.
        hdu_index: The 0-based index of the HDU to read.
        chunk_size: The number of rows to include in each chunk.
    """
    try:
        with fits.open(file_path) as hdul:
            if not (0 <= hdu_index < len(hdul)):
                raise ValueError(f"HDU index {hdu_index} is out of bounds.")

            hdu = hdul[hdu_index]
            if not isinstance(hdu, (fits.BinTableHDU, fits.TableHDU)):
                raise TypeError(f"HDU {hdu_index} ('{hdu.name}') is not a table HDU.")

            num_rows = len(hdu.data)
            if num_rows == 0:
                # Still send a valid, empty JSON structure so the frontend knows what to do.
                # Create an empty DataFrame with the correct columns.
                empty_df = fix_multi_dim_tables(Table(hdu.data)).to_pandas()
                # Send the schema and an empty data array.
                print(empty_df.to_json(orient="table", index=False), flush=True)
                return

            # Send the schema as the first chunk
            schema_df = fix_multi_dim_tables(Table(hdu.data[0:1])).to_pandas()
            schema_json = schema_df.to_json(orient="table", index=False)
            parsed_schema = json.loads(schema_json)
            # We only want to send the schema part, not the single row of data
            schema_only_message = {"schema": parsed_schema["schema"], "data": []}
            print(json.dumps(schema_only_message), flush=True)


            # Now, send the data in chunks
            for i in range(0, num_rows, chunk_size):
                end = min(i + chunk_size, num_rows)
                
                # Convert the FITS table slice to an Astropy Table, then to Pandas
                astropy_table_chunk = fix_multi_dim_tables(Table(hdu.data[i:end]))
                df_chunk = astropy_table_chunk.to_pandas()

                # Convert DataFrame to JSON records format (an array of objects)
                # This is efficient and easy for the frontend to parse.
                # default_handler=str helps sanitize non-standard data types.
                json_chunk = df_chunk.to_json(orient="records", default_handler=str)
                
                # Print the chunk followed by a newline delimiter and flush stdout
                print(json_chunk, flush=True)

    except Exception as e:
        # Print any errors as a JSON object so the frontend can display them
        error_message = json.dumps({"error": str(e)})
        print(error_message, flush=True)
        sys.exit(1)


def main():
    """
    Main entry point for the script.
    Parses command-line arguments to determine which function to run.
    """
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Insufficient arguments."}), flush=True)
        sys.exit(1)

    command = sys.argv[1]
    file_path = sys.argv[2]

    if not Path(file_path).exists():
        print(json.dumps({"error": f"File does not exist at path: {file_path}"}), flush=True)
        sys.exit(1)

    if command == "info":
        print(get_hdu_info(file_path))
    elif command == "data":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "HDU index is required for the 'data' command."}), flush=True)
            sys.exit(1)
        try:
            hdu_index = int(sys.argv[3])
            stream_table_data(file_path, hdu_index)
        except ValueError:
            print(json.dumps({"error": "HDU index must be an integer."}), flush=True)
            sys.exit(1)
    else:
        print(json.dumps({"error": f"Unknown command: '{command}'"}), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
