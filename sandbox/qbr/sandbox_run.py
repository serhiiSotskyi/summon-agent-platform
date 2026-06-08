"""Local QBR execution adapter for sandbox usage.

Runs the vendored QBR pipeline for a single CSV and returns:
- PPTX artifact path
- serialized metrics JSON payload
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

import numpy as np
import pandas as pd

from src.config_loader import ConfigLoader
from src.data_loader import QuarterInfo, detect_latest_complete_quarter, load_csv
from src.metrics import prepare_report_data
from src.report_pipeline import ReportPipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local QBR pipeline and emit PPTX + metrics JSON.",
    )
    parser.add_argument("--input-csv", required=True, help="Path to the performance CSV file.")
    parser.add_argument("--output-dir", default=None, help="Directory for generated outputs (default: sandbox/qbr/output).")
    parser.add_argument("--client-id", default=None, help="Client ID to use from clients_config.json.")
    parser.add_argument(
        "--output-pptx",
        default="qbr_report.pptx",
        help="PPTX filename (default: qbr_report.pptx).",
    )
    parser.add_argument(
        "--output-json",
        default="qbr_metrics.json",
        help="Metrics JSON filename (default: qbr_metrics.json).",
    )
    parser.add_argument("--auction-csv", default=None, help="Optional Google Ads auction insights CSV path.")
    parser.add_argument("--trends-dir", default=None, help="Optional directory with Google Trends CSV exports.")
    parser.add_argument("--max-kpi-rows", type=int, default=20, help="Optional cap on serialized top-level campaign/destination rows.")
    parser.add_argument("--report-year", type=int, default=None, help="Explicit report year, e.g. 2026.")
    parser.add_argument("--report-quarter", type=int, choices=[1, 2, 3, 4], default=None, help="Explicit report quarter.")
    return parser.parse_args()


def _as_json_compatible(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, pd.DataFrame):
        return [_as_json_compatible(record) for record in value.to_dict(orient="records")]
    if isinstance(value, pd.Series):
        return {_as_json_compatible(k): _as_json_compatible(v) for k, v in value.to_dict().items()}
    if isinstance(value, dict):
        return {_as_json_compatible(k): _as_json_compatible(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_as_json_compatible(item) for item in value]
    if isinstance(value, QuarterInfo):
        return {
            "year": value.year,
            "quarter": value.quarter,
            "label": value.label,
            "start": _as_json_compatible(value.start),
            "end": _as_json_compatible(value.end),
        }
    return value


def _strip_scope(
    scope_data: Dict[str, Any],
    *,
    max_rows: int,
) -> Dict[str, Any]:
    return {
        "total": _as_json_compatible(scope_data.get("total")),
        "prior_total": _as_json_compatible(scope_data.get("prior_total")),
        "yoy": _as_json_compatible(scope_data.get("yoy")),
        "kpis": _as_json_compatible(scope_data.get("kpis", [])),
        "monthly": _as_json_compatible(scope_data.get("monthly", pd.DataFrame()).head(max_rows)),
    }


def _build_payload(
    input_csv: Path,
    client_name: str,
    report_title: str,
    client_id: str,
    quarter: Any,
    report: Dict[str, Any],
    row_count: int,
    min_date: Any,
    max_date: Any,
    output_pptx: Path,
    output_json: Path,
    max_rows: int,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "status": "ok",
        "input": {
            "source_csv": str(input_csv),
            "client_id": client_id,
            "client_name": client_name,
        },
        "report_title": report_title,
        "row_count": row_count,
        "date_range": {
            "min": _as_json_compatible(min_date),
            "max": _as_json_compatible(max_date),
        },
        "quarter": _as_json_compatible(quarter),
        "outputs": {
            "pptx_path": str(output_pptx),
            "metrics_json_path": str(output_json),
        },
        "metrics": {
            "include_revenue": report.get("include_revenue", False),
            "overall": _strip_scope(report["overall"], max_rows=max_rows),
            "campaigns": {name: _strip_scope(scope, max_rows=max_rows) for name, scope in report["campaigns"].items()},
            "destinations": {
                name: _strip_scope(scope, max_rows=max_rows) for name, scope in report["destinations"].items()
            },
            "destination_excluded_total": _as_json_compatible(report.get("destination_excluded_total", {})),
            "available_campaigns": list(report.get("available_campaigns", [])),
            "available_destinations": list(report.get("available_destinations", [])),
        },
    }
    return payload


def _build_client_config(project_root: Path, client_id: str | None) -> Dict[str, Any]:
    config_loader = ConfigLoader(
        report_config_path=project_root / "config" / "report_config.yaml",
        chart_styles_path=project_root / "config" / "chart_styles.yaml",
        clients_config_path=project_root / "config" / "clients_config.json",
    )
    return config_loader.get_client_config(client_id)


def _select_quarter(df: pd.DataFrame, report_year: int | None, report_quarter: int | None) -> QuarterInfo:
    if report_year is None and report_quarter is None:
        return detect_latest_complete_quarter(df)
    if report_year is None or report_quarter is None:
        raise ValueError("Both --report-year and --report-quarter are required when selecting a specific period.")
    quarter = QuarterInfo(year=report_year, quarter=report_quarter)
    quarter_df = df[(df["year"] == quarter.year) & (df["quarter"] == quarter.quarter)]
    prior_df = df[(df["year"] == quarter.year - 1) & (df["quarter"] == quarter.quarter)]
    if quarter_df.empty:
        raise ValueError(f"No rows found for selected report period {quarter.label}.")
    if prior_df.empty:
        raise ValueError(f"No prior-year comparison rows found for selected report period {quarter.label}.")
    return quarter


def main() -> None:
    args = parse_args()
    project_root = Path(__file__).resolve().parent
    input_csv = Path(args.input_csv).expanduser()
    output_dir = Path(args.output_dir or (project_root / "output")).expanduser()
    output_pptx = output_dir / args.output_pptx
    output_json = output_dir / args.output_json

    try:
        if not input_csv.exists() or not input_csv.is_file():
            raise FileNotFoundError(f"Input CSV not found: {input_csv}")
        if args.max_kpi_rows <= 0:
            raise ValueError("max-kpi-rows must be greater than 0.")

        config_loader = ConfigLoader(
            report_config_path=project_root / "config" / "report_config.yaml",
            chart_styles_path=project_root / "config" / "chart_styles.yaml",
            clients_config_path=project_root / "config" / "clients_config.json",
        )
        client_config = config_loader.get_client_config(args.client_id)
        client_id = str(client_config["id"])

        df = load_csv(input_csv)
        quarter = _select_quarter(df, args.report_year, args.report_quarter)
        report = prepare_report_data(
            df,
            quarter,
            campaign_order=client_config.get("campaign_types"),
            destination_order=client_config.get("destinations"),
            destination_other_config=client_config.get("destination_other"),
        )

        pipeline = ReportPipeline(project_root=project_root)
        pipeline.charts_root = output_dir / "charts"
        pipeline.output_root = output_dir
        generated_pptx = Path(
            pipeline.run(
                input_csv=str(input_csv),
                output_pptx=str(output_pptx),
                client_id=client_id,
                quarter=quarter,
                auction_csv=args.auction_csv,
                trends_dir=args.trends_dir,
            )
        )

        payload = _build_payload(
            input_csv=input_csv,
            client_name=config_loader.get_client_name(client_config),
            report_title=config_loader.get_report_title(client_config),
            client_id=client_id,
            quarter=quarter,
            report=report,
            row_count=len(df),
            min_date=df["date"].min(),
            max_date=df["date"].max(),
            output_pptx=generated_pptx,
            output_json=output_json,
            max_rows=args.max_kpi_rows,
        )
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        output_pptx_path = str(generated_pptx)

        payload["outputs"]["pptx_path"] = output_pptx_path
        print(json.dumps({
            "status": "ok",
            "input": payload["input"],
            "report_title": payload["report_title"],
            "row_count": payload["row_count"],
            "date_range": payload["date_range"],
            "outputs": payload["outputs"],
            "metrics": payload["metrics"],
            "quarter": payload["quarter"],
        }))
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        print(json.dumps({"status": "error", "error": "Python 3.10+ is required."}))
        raise SystemExit(1)
    main()
