#!/usr/bin/env python3

import argparse
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, Normalize
import numpy as np
import requests
from eccodes import (
    codes_get,
    codes_get_array,
    codes_grib_new_from_file,
    codes_release,
)

NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"

WEST = -99.0
EAST = -30.0
SOUTH = 7.0
NORTH = 40.0

# NOAA's request uses 0–360 longitude.
LEFT_LON_360 = 261
RIGHT_LON_360 = 330

USER_AGENT = "DavidB.xyz StormWatch (https://davidb.xyz)"

TEST_HOURS = [0, 3, 6]
FULL_HOURS = list(range(0, 241, 3))

PNG_WIDTH = 1400
PNG_HEIGHT = 700

# Color anchors are expressed in feet. The palette intentionally emphasizes
# the transition from ordinary seas into increasingly hazardous wave heights.
WAVE_COLOR_ANCHORS = [
    (0.0, "#1f4f99"),
    (2.0, "#277db6"),
    (4.0, "#35b7b4"),
    (6.0, "#5ac85a"),
    (8.0, "#d7d84b"),
    (10.0, "#f3ad42"),
    (12.0, "#ef7a36"),
    (16.0, "#e44946"),
    (20.0, "#bd3c78"),
    (25.0, "#8f46a9"),
    (30.0, "#7137a3"),
]


@dataclass
class Field:
    latitudes: np.ndarray
    longitudes: np.ndarray
    values: np.ndarray
    short_name: str
    name: str


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("test", "full"),
        default="test",
        help="test builds +0/+3/+6; full builds every 3h through +240",
    )
    return parser.parse_args()


def utc_cycle_candidates():
    """Yield recent 6-hour GFS cycles, newest first."""
    now = datetime.now(timezone.utc)
    boundary_hour = (now.hour // 6) * 6
    boundary = now.replace(
        hour=boundary_hour,
        minute=0,
        second=0,
        microsecond=0,
    )

    # Start one cycle back. That gives NOAA time to finish posting the data.
    start = boundary - timedelta(hours=6)

    for offset in range(0, 24, 6):
        yield start - timedelta(hours=offset)


def cycle_parts(dt):
    return dt.strftime("%Y%m%d"), dt.strftime("%H")


def build_nomads_url(cycle_dt, forecast_hour, variables):
    date, cycle = cycle_parts(cycle_dt)
    fhr = f"{forecast_hour:03d}"

    params = {
        "file": f"gfswave.t{cycle}z.global.0p16.f{fhr}.grib2",
        "lev_surface": "on",
        "subregion": "",
        "leftlon": str(LEFT_LON_360),
        "rightlon": str(RIGHT_LON_360),
        "toplat": str(int(NORTH)),
        "bottomlat": str(int(SOUTH)),
        "dir": f"/gfs.{date}/{cycle}/wave/gridded",
    }

    for variable in variables:
        params[f"var_{variable}"] = "on"

    return requests.Request(
        "GET",
        NOMADS_FILTER,
        params=params,
    ).prepare().url


def looks_like_grib2(data):
    return (
        len(data) >= 8
        and data[0:4] == b"GRIB"
        and data[7] == 2
    )


def request_grib(cycle_dt, forecast_hour, variables=("HTSGW", "WIND", "WDIR")):
    url = build_nomads_url(cycle_dt, forecast_hour, variables)
    response = requests.get(
        url,
        timeout=120,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": USER_AGENT,
        },
    )

    if not response.ok or not looks_like_grib2(response.content):
        raise RuntimeError(
            f"NOMADS did not return GRIB2 for "
            f"{cycle_dt:%Y%m%d %HZ} f{forecast_hour:03d}; "
            f"HTTP {response.status_code}"
        )

    return response.content


def choose_cycle():
    print("Finding latest safe GFS-Wave cycle...")

    for candidate in utc_cycle_candidates():
        try:
            # Probe with only the wave field to minimize the discovery request.
            request_grib(candidate, 0, variables=("HTSGW",))
            print(f"Using GFS-Wave cycle {candidate:%Y-%m-%d %HZ}")
            return candidate
        except Exception as exc:
            print(f"  {candidate:%Y-%m-%d %HZ} unavailable: {exc}")

    raise RuntimeError("No recent GFS-Wave cycle could be retrieved.")


def normalize_lon(lon):
    lon = np.asarray(lon, dtype=float)
    return np.where(lon > 180.0, lon - 360.0, lon)


def safe_get(gid, key, default=""):
    try:
        return codes_get(gid, key)
    except Exception:
        return default


def classify_message(short_name, name):
    s = str(short_name).strip().lower()
    n = str(name).strip().lower()

    if s in {"swh", "htsgw"} or "significant height" in n:
        return "wave"

    if s in {"wind", "si10"} or n == "wind speed" or "wind speed" in n:
        return "wind_speed"

    if s in {"wdir"} or "wind direction" in n:
        return "wind_direction"

    return None


def decode_fields(grib_path):
    fields = {}

    with open(grib_path, "rb") as fh:
        while True:
            gid = codes_grib_new_from_file(fh)
            if gid is None:
                break

            try:
                short_name = safe_get(gid, "shortName", "")
                name = safe_get(gid, "name", "")
                kind = classify_message(short_name, name)

                if kind and kind not in fields:
                    latitudes = np.asarray(
                        codes_get_array(gid, "latitudes"),
                        dtype=float,
                    )
                    longitudes = normalize_lon(
                        codes_get_array(gid, "longitudes")
                    )
                    values = np.asarray(
                        codes_get_array(gid, "values"),
                        dtype=float,
                    )

                    missing_value = safe_get(gid, "missingValue", None)
                    if missing_value not in (None, ""):
                        try:
                            missing_value = float(missing_value)
                            values[np.isclose(values, missing_value)] = np.nan
                        except Exception:
                            pass

                    # Defensive mask for GRIB missing sentinels.
                    values[np.abs(values) > 1e20] = np.nan

                    fields[kind] = Field(
                        latitudes=latitudes,
                        longitudes=np.asarray(longitudes, dtype=float),
                        values=values,
                        short_name=str(short_name),
                        name=str(name),
                    )
            finally:
                codes_release(gid)

    if "wave" not in fields:
        raise RuntimeError(
            "Could not find the significant-wave-height message in the GRIB2 file."
        )

    return fields


def gridify(field):
    # NOAA's regional GFS-Wave grid is regular lat/lon. Round coordinates so
    # floating point representation does not create duplicate grid coordinates.
    lats_r = np.round(field.latitudes, 5)
    lons_r = np.round(field.longitudes, 5)

    lat_axis = np.unique(lats_r)
    lon_axis = np.unique(lons_r)

    lat_axis.sort()
    lon_axis.sort()

    lat_index = {value: i for i, value in enumerate(lat_axis)}
    lon_index = {value: i for i, value in enumerate(lon_axis)}

    grid = np.full(
        (len(lat_axis), len(lon_axis)),
        np.nan,
        dtype=np.float32,
    )

    for lat, lon, value in zip(lats_r, lons_r, field.values):
        if (
            SOUTH - 0.5 <= lat <= NORTH + 0.5
            and WEST - 0.5 <= lon <= EAST + 0.5
            and np.isfinite(value)
        ):
            grid[lat_index[lat], lon_index[lon]] = value

    return lat_axis, lon_axis, grid


def mercator_y_from_lat(lat_deg):
    lat_rad = np.radians(np.clip(lat_deg, -85.0, 85.0))
    return np.log(np.tan(np.pi / 4.0 + lat_rad / 2.0))


def make_wave_colormap():
    max_ft = WAVE_COLOR_ANCHORS[-1][0]
    positions = [height / max_ft for height, _ in WAVE_COLOR_ANCHORS]
    colors = [color for _, color in WAVE_COLOR_ANCHORS]

    cmap = LinearSegmentedColormap.from_list(
        "stormwatch_wave",
        list(zip(positions, colors)),
    )
    cmap.set_bad((0, 0, 0, 0))
    cmap.set_over(colors[-1])
    return cmap


def nearest_regrid(source_field, target_lats, target_lons):
    src_lats, src_lons, src_grid = gridify(source_field)

    lat_idx = np.searchsorted(src_lats, target_lats)
    lat_idx = np.clip(lat_idx, 0, len(src_lats) - 1)

    lon_idx = np.searchsorted(src_lons, target_lons)
    lon_idx = np.clip(lon_idx, 0, len(src_lons) - 1)

    return src_grid[np.ix_(lat_idx, lon_idx)]


def render_frame(fields, output_path):
    wave_lats, wave_lons, wave_m = gridify(fields["wave"])

    # HTSGW is meters; the StormWatch display uses feet.
    wave_ft = wave_m * 3.28084
    wave_ft = np.ma.masked_invalid(wave_ft)

    x = np.radians(wave_lons)
    y = mercator_y_from_lat(wave_lats)

    dpi = 100
    fig = plt.figure(
        figsize=(PNG_WIDTH / dpi, PNG_HEIGHT / dpi),
        dpi=dpi,
        frameon=False,
    )
    ax = fig.add_axes([0, 0, 1, 1])
    fig.patch.set_alpha(0)
    ax.set_facecolor((0, 0, 0, 0))

    cmap = make_wave_colormap()
    norm = Normalize(vmin=0, vmax=WAVE_COLOR_ANCHORS[-1][0])

    ax.pcolormesh(
        x,
        y,
        wave_ft,
        shading="auto",
        cmap=cmap,
        norm=norm,
        rasterized=True,
    )

    if "wind_direction" in fields:
        # Regrid wind direction (and speed if present) onto the wave grid so
        # arrows can be sampled from a single regular lattice.
        wind_dir = nearest_regrid(
            fields["wind_direction"],
            wave_lats,
            wave_lons,
        )

        if "wind_speed" in fields:
            wind_speed = nearest_regrid(
                fields["wind_speed"],
                wave_lats,
                wave_lons,
            )
        else:
            wind_speed = np.full_like(wind_dir, 10.0)

        # Aim for roughly 18-24 arrows across the width.
        stride = max(1, int(len(wave_lons) / 22))

        sample_lats = wave_lats[::stride]
        sample_lons = wave_lons[::stride]
        sample_dir = wind_dir[::stride, ::stride]
        sample_speed = wind_speed[::stride, ::stride]

        lon_mesh, lat_mesh = np.meshgrid(sample_lons, sample_lats)
        xq = np.radians(lon_mesh)
        yq = mercator_y_from_lat(lat_mesh)

        # WDIR is the direction FROM which wind blows.
        theta = np.radians(sample_dir)

        # Point arrows toward the direction the wind is traveling.
        u = -np.sin(theta)
        v = -np.cos(theta)

        # Keep arrows readable while still giving stronger winds slightly
        # longer vectors.
        speed_factor = np.clip(sample_speed / 12.0, 0.65, 1.8)
        u *= speed_factor
        v *= speed_factor

        invalid = (
            ~np.isfinite(sample_dir)
            | ~np.isfinite(sample_speed)
        )
        u[invalid] = np.nan
        v[invalid] = np.nan

        ax.quiver(
            xq,
            yq,
            u,
            v,
            color="white",
            alpha=0.78,
            pivot="middle",
            angles="uv",
            scale=28,
            width=0.0018,
            headwidth=3.5,
            headlength=4.5,
            headaxislength=4.0,
        )

    ax.set_xlim(np.radians(WEST), np.radians(EAST))
    ax.set_ylim(
        mercator_y_from_lat(SOUTH),
        mercator_y_from_lat(NORTH),
    )
    ax.set_axis_off()

    output_path.parent.mkdir(parents=True, exist_ok=True)

    fig.savefig(
        output_path,
        transparent=True,
        dpi=dpi,
        pad_inches=0,
    )
    plt.close(fig)


def make_s3():
    required = [
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_ENDPOINT",
        "R2_BUCKET",
    ]

    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            "Missing required environment variables: "
            + ", ".join(missing)
        )

    return boto3.client(
        service_name="s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_file(s3, bucket, local_path, key, cache_control):
    s3.upload_file(
        str(local_path),
        bucket,
        key,
        ExtraArgs={
            "ContentType": "image/png",
            "CacheControl": cache_control,
        },
    )
    print(f"Uploaded s3://{bucket}/{key}")


def upload_json(s3, bucket, key, payload, cache_control):
    body = json.dumps(payload, indent=2).encode("utf-8")

    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json; charset=utf-8",
        CacheControl=cache_control,
    )
    print(f"Uploaded s3://{bucket}/{key}")


def main():
    args = parse_args()
    hours = TEST_HOURS if args.mode == "test" else FULL_HOURS

    cycle_dt = choose_cycle()
    cycle_id = cycle_dt.strftime("%Y%m%dT%HZ")
    bucket = os.environ.get("R2_BUCKET", "stormwatch-gfs-wave")
    s3 = make_s3()

    if args.mode == "test":
        frame_prefix = f"test/{cycle_id}"
        manifest_key = "test/manifest.json"
    else:
        frame_prefix = f"cycles/{cycle_id}"
        manifest_key = "latest/manifest.json"

    completed_hours = []

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_dir = Path(temp_dir)

        for forecast_hour in hours:
            print()
            print(f"=== Forecast +{forecast_hour:03d}h ===")

            try:
                grib_bytes = request_grib(
                    cycle_dt,
                    forecast_hour,
                )
            except Exception as exc:
                # A full run should fail loudly if any expected frame is absent.
                raise RuntimeError(
                    f"Failed downloading f{forecast_hour:03d}: {exc}"
                ) from exc

            grib_path = temp_dir / f"f{forecast_hour:03d}.grib2"
            grib_path.write_bytes(grib_bytes)

            fields = decode_fields(grib_path)

            print(
                "Fields:",
                ", ".join(
                    f"{key}={value.short_name or value.name}"
                    for key, value in fields.items()
                ),
            )

            png_path = temp_dir / f"f{forecast_hour:03d}.png"
            render_frame(fields, png_path)

            key = f"{frame_prefix}/f{forecast_hour:03d}.png"
            upload_file(
                s3,
                bucket,
                png_path,
                key,
                "public, max-age=31536000, immutable",
            )
            completed_hours.append(forecast_hour)

    manifest = {
        "model": "NOAA/NCEP GFS-Wave",
        "product": "Significant wave height with surface wind vectors",
        "cycle": cycle_id,
        "cycleTime": cycle_dt.isoformat(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "mode": args.mode,
        "bounds": {
            "south": SOUTH,
            "north": NORTH,
            "west": WEST,
            "east": EAST,
        },
        "forecastHours": completed_hours,
        "framePrefix": frame_prefix,
        "framePattern": "f{hour:03d}.png",
        "waveHeightUnits": "feet",
        "sourceResolutionDegrees": 0.16,
    }

    upload_json(
        s3,
        bucket,
        manifest_key,
        manifest,
        "no-cache, max-age=60",
    )

    print()
    print("Build complete.")
    print(f"Cycle: {cycle_id}")
    print(f"Frames: {len(completed_hours)}")
    print(f"Manifest: s3://{bucket}/{manifest_key}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
