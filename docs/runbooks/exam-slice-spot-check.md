# How to load and spot-check an exam slice

*Type: how-to* — Use this page to load about 200 items of one exam stage (for example SSC CGL Tier 1, Quant) from a file into the Platform tenant, and to check 20 of them by hand.

> [!WARNING]
> Do not use content that you do not have the right to use. Set `--rights-status` to the true status of the file. The tool records the status on every item.

## Before you start

- You need a `.csv` or `.xlsx` file. One row is one item. The first row is the header.
- The header must have these columns: `type`, `topic`, `question`, `options`, `correct`, `rationale`. These are the columns for the `mcq` type. Other types use other answer columns.
- Add the optional columns `exam_stage`, `subject_path`, `difficulty`, `source_ref` and `rights_status` if you have them. Add `subtopic` if you want the check list to cover each subtopic.
- To get an empty template for one type, open `/api/admin/super/question-imports/templates/mcq?format=csv` when you are signed in as super admin.
- The file must be 4 MB or smaller and must have 2000 rows or fewer.
- The domain must exist in the Platform tenant.
- The code of this tool must be on the VPS. Deploy the `assessiq-api` image once after the EXP-15 commit, because the tool uses the new `previewImport` function.

## Step 1: put the file on the VPS

1. Copy the file to the VPS: `scp slice.csv assessiq-vps:/tmp/slice.csv`
2. Copy the file into the api container: `ssh assessiq-vps 'docker cp /tmp/slice.csv assessiq-api:/tmp/slice.csv'`

## Step 2: run the dry run

The dry run reads the database. It does not write to it.

1. Run this command. Change the values in the quotes.

   ```bash
   ssh assessiq-vps 'docker exec assessiq-api pnpm exec tsx tools/exam-slice/load.mjs --dry-run \
     --file /tmp/slice.csv --domain "<domain-slug>" --pack-name "SSC CGL Tier 1 Quant slice 1" \
     --rights-status original --source-ref "<id of the source>" --out /tmp/slice-report.md'
   ```

2. Read the summary line on the screen. It shows rows, valid, errors, duplicates, missing keys and the 20 rows to check.
3. Copy the report to your computer:
   `ssh assessiq-vps 'docker exec assessiq-api cat /tmp/slice-report.md' > slice-report.md`

The flags:

| Flag | Meaning |
| --- | --- |
| `--file` | The path inside the container. |
| `--domain` | The domain slug in the Platform tenant. |
| `--pack-name` | The name of the new draft pack. |
| `--rights-status` | One of `original`, `derived_from_source`, `scraped_raw`, `licensed`, `metadata_only`. The tool uses it for every row where the `rights_status` cell is empty. |
| `--source-ref` | Free text id of the source. The tool writes it to the `source_ref` field of every item where the cell is empty. The report shows it. |
| `--out` | The path of the report file. |

## Step 3: read the report

1. Open `slice-report.md`.
2. Read the **Counts** table. Look at these lines first: Errors, Duplicates, Missing answer key.
3. Read the **Items** table. The last column, Problem, tells you what is wrong with a row.
4. If Errors is not 0, fix the rows in your file. Copy the file again (Step 1) and run the dry run again.

Notes:

- A duplicate is not loaded. "Inside the file" means an earlier row has the same text. "Existing" means a question in the domain has the same text.
- A "similar" row is only a warning. The row is still loaded.
- A passing dry run (Errors is 0) is saved for one hour. The apply step needs it.

## Step 4: apply

Apply creates one draft pack. Every item starts in the state "in review".

1. Run the same command as in Step 2, but replace `--dry-run` with `--apply`. Use the same flags and the same file.
2. Read the summary line. It shows the number of items loaded and the pack id.
3. If the tool says "apply refused", run the dry run again, then apply within one hour.
4. To load the valid rows when some rows have errors, add `--skip-errors`. We do not advise this for the first load.

> [!NOTE]
> The tool needs the dry run and the apply to run in the same container. A container restart deletes the saved dry run. Run the dry run again.

## Step 5: check the 20 items

The report lists the rows to check. It always includes every row that has a problem. It adds at least 2 rows for each subtopic and fills the rest at random. The list is the same every time for the same file and flags.

1. Open the admin app and go to **Question bank**.
2. Open the new pack and open its review page: `/admin/question-bank/<pack id>/review`.
3. For each listed row, find the item by its question text. The review page does not show row numbers. The row number in the report is the row in your file.
4. Compare these things with your source:
   - the question text
   - every option
   - the answer key
   - the solution (the rationale)
   - the difficulty
   - the source (the `source_ref`)
5. If all is correct, choose **Verify**.

## Step 6: handle an item that is wrong

- **The item has a small error, and you will correct it.** Choose **Needs fix**. A note is required. Write what is wrong. Correct the item later.
- **The item must not be used** (wrong rights, wrong content). Choose **Withdraw**. A withdrawn item cannot be undone. It is archived and its rights status becomes `withdrawn`.
- **Many items are wrong.** Do not verify the pack. Withdraw or mark each wrong item. Tell the developer.

The review page works on the whole pack. Do not use **Verify all** until you have checked the 20 items.

## If you get an error

| What you see | What to do |
| --- | --- |
| `apply refused: no passing dry run` | Run the dry run again. Use the same file and the same flags. Then apply within one hour. |
| `apply refused: N row(s) have errors` | Fix the file, or add `--skip-errors`. |
| `domain '...' does not exist` | Check the `--domain` slug in the admin app. |
| `the platform tenant has no active super admin` | Stop. Tell the developer. |
| `Header row must contain a "type" column` | Check that the first row of the file is the header. |
| `File exceeds ...` | Split the file into two files. |
| `rights_status ... is not allowed` | Use one of the five allowed values. |
| Any other error text | Copy the full text. Do not run apply again. Tell the developer. |

To load a second slice, use a new pack name and a new file.
