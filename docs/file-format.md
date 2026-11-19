# The Lineboard file format (`.lbd`)

A Lineboard document holds one or more notes, grouped in notebooks, with their pictures. Lineboard
exports a single note, a notebook or all notes as an `.lbd` file, and imports them back. "Download my data"
puts all your notes in one, next to your account details.

An `.lbd` file is a **ZIP archive** (like `.docx`). Rename it to `.zip` to look inside with any zip tool.
Entries are stored or deflated.

```
lineboard.json          the manifest
notes/0001.json         one file per note
notes/0002.json
pictures/<name>.png     the pictures the notes use (PNG or JPEG)
```

## `lineboard.json`

```json
{
  "format": "lineboard",
  "version": 1,
  "exported_at": "2026-11-19T12:00:00.000Z",
  "notebooks": [
    { "name": "Physics", "notes": [{ "file": "notes/0001.json" }, { "file": "notes/0002.json" }] }
  ]
}
```

- **`format`**: always `"lineboard"`.
- **`version`**: the format version, currently 1. A reader refuses versions newer than it knows.
- **`notebooks`**: in order. Each notebook has a `name` and its `notes`, and each note entry points at its file.

## A note

```json
{
  "title": "Waves",
  "created_at": "2026-11-19T10:00:00.000Z",
  "updated_at": "2026-11-19T11:30:00.000Z",
  "strokes": [ ... ]
}
```

## Strokes

Everything on a page is a stroke, drawn in order.

| Field | |
| --- | --- |
| `tool` | `"pen"`, `"highlighter"`, `"text"` or `"image"` |
| `color` | `#rrggbb` (or `#rgb`, `#rrggbbaa`); for `image`, the picture's file type, e.g. `image/png` |
| `width` | pen / highlighter width or text font size, in page units (0 < width ≤ 100) |
| `points` | a flat list `x, y, pressure, x, y, pressure, ...` |
| `created_at` | optional |

`points` are in **page units**: the page is 1000 units wide, and *y* grows downwards. Pressure is between
0 and 1.

What `points` means depends on the tool:

- **`pen`** and **`highlighter`**: the points of the line.
  - Shapes are pen strokes that trace their outline.
  - `dash` (`"dashed"` or `"dotted"`) draws them dashed or dotted.
  - A repeated point marks a sharp corner.
- **`text`**: one point, the top-left corner of the box.
  - `text` holds the text, with lines separated by `\n`.
  - `font` is optional: `{ "family": "serif" | "mono" | "hand", "bold": true, "italic": true, "underline": true, "align": "center" | "right" }`. Missing keys mean sans, regular and left-aligned.
- **`image`**: two points, the top-left and bottom-right corners.
  - `picture` is the path of the picture in the archive, e.g. `"pictures/3f2a….png"`.

If a picture could not be read when the file was made, its stroke keeps its place and size with
`"missing": true` and no `picture`. The manifest then has `"missing_pictures": <count>`, and Lineboard says
so when exporting. Importing leaves such strokes out and counts them.

Notes and strokes have no ids in the file. Importing gives them new ones, so an import never replaces
existing notes.

## Importing

Lineboard imports:

- an **`.lbd`** file;
- a **`.zip` of `.lbd` files**, such as several exported notes zipped together, or a "Download my data" archive.

Where imported notes go:

- A file with **one note** goes into the open notebook.
- Otherwise, each notebook's notes go into the notebook with the **same name**, which is created if it doesn't exist.

Files are treated as untrusted:

- **Size limits:** at most 20,000 notes, 50,000 strokes per note, 20,000 points per stroke, 10,000 characters per text box and 15 MB per picture.
- **One budget per import:** the limits count across everything in one import, so a zip of many `.lbd` files gets the same allowance as a single file: 20,000 notes, 2,000,000 strokes and 1.5 GB unpacked in total.
- **No deep nesting:** a zip is opened once and only the `.lbd` files directly in it are read; an `.lbd` is opened once and only its manifest, notes and pictures are used. Archives inside an `.lbd`, and zips inside a zip, are ignored. Every entry must unpack to exactly its declared size and CRC, and encrypted, multi-part and zip64 archives are refused.
- **Strokes that don't follow this description** are left out, and the import reports how many.
- **Pictures** are decoded and re-encoded before they are stored.
- **Zip archives** are rejected if they are encrypted, split into parts, use zip64, or unpack to more than they declare.
