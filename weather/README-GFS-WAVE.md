# StormWatch GFS-Wave frame builder

This package creates transparent GFS-Wave image overlays from NOAA/NCEP GRIB2
and uploads them to the `stormwatch-gfs-wave` Cloudflare R2 bucket.

## Add these files to your Storm Watch repository

Copy:

- `.github/workflows/gfs-wave-frames.yml`
- `scripts/gfs-wave/build_frames.py`
- `scripts/gfs-wave/requirements.txt`

Commit and push them.

## Add three GitHub Actions repository secrets

In GitHub:

Settings -> Secrets and variables -> Actions -> New repository secret

Create:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT`

For `R2_ENDPOINT`, use the full endpoint Cloudflare showed you, for example:

`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

Do not include a bucket name at the end.

The bucket name itself is already set to `stormwatch-gfs-wave` in the workflow.

## First run

Go to:

Actions -> Build GFS-Wave Frames -> Run workflow

Leave `mode` set to `test`.

The test run creates only forecast hours:

- +0
- +3
- +6

They are uploaded under:

`test/<cycle>/f000.png`
`test/<cycle>/f003.png`
`test/<cycle>/f006.png`

The test manifest is:

`test/manifest.json`

This deliberately does NOT touch `latest/manifest.json`.

## Full run

After the three test frames look correct, run the workflow again with:

`mode = full`

That builds every 3 hours from +0 through +240 (81 frames), stores them under:

`cycles/<cycle>/f000.png`
...
`cycles/<cycle>/f240.png`

and updates:

`latest/manifest.json`

only after all frames have uploaded.

## Automation

Do not enable the scheduled run until the manual test and manual full run have
both succeeded. We will add the schedule after the frontend is displaying the
frames correctly.
