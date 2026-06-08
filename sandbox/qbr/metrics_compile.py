"""Compile QBR calculations into a slide-ready JSON blueprint.

This runner intentionally does not create charts, images, PPTX files, or
Google Slides. It keeps Python responsible for deterministic data work only:

- period detection / validation
- KPI totals and YoY calculations
- monthly tables
- campaign and destination cuts
- trend / auction summaries when optional inputs are supplied
- narrative bullets and recommendations
- chart data series that a separate Slides writer can render natively

The output is designed for an agent/tool loop that copies a designed Google
Slides reference deck and fills native text, tables, and charts from this JSON.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

import numpy as np
import pandas as pd

from src.auction_loader import load_auction_csv
from src.auction_metrics import summarize_auction_insights
from src.config_loader import ConfigLoader
from src.data_loader import QuarterInfo, detect_latest_complete_quarter, load_csv
from src.metrics import (
    format_summary_table,
    prepare_report_data,
    validate_report_data,
)
from src.narrative_generator import (
    generate_auction_bullets,
    generate_mix_bullets,
    generate_overall_bullets,
    generate_scope_bullets,
    generate_trend_bullets,
)
from src.recommendation_generator import generate_recommendations
from src.trends_loader import TrendsLoader
from src.trends_metrics import summarize_trends


REFERENCE_DECK_URL = "https://docs.google.com/presentation/d/1ctx-YpaHfYTJ-sJgWW_BGUTtbeLiEU7xF2JX76CkNkw"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile QBR calculations into a slide-ready JSON blueprint.",
    )
    parser.add_argument("--input-csv", required=True, help="Path to the performance CSV file.")
    parser.add_argument("--output-json", required=True, help="Path to write calculation blueprint JSON.")
    parser.add_argument("--client-id", default=None, help="Client ID to use from clients_config.json.")
    parser.add_argument("--auction-csv", default=None, help="Optional Google Ads auction insights CSV path.")
    parser.add_argument("--trends-dir", default=None, help="Optional directory with Google Trends CSV exports.")
    parser.add_argument("--report-year", type=int, default=None, help="Explicit report year, e.g. 2026.")
    parser.add_argument("--report-quarter", type=int, choices=[1, 2, 3, 4], default=None, help="Explicit report quarter.")
    parser.add_argument("--max-scope-count", type=int, default=24, help="Cap campaign/destination scopes in output.")
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
        return {_as_json_compatible(key): _as_json_compatible(item) for key, item in value.to_dict().items()}
    if isinstance(value, dict):
        return {_as_json_compatible(key): _as_json_compatible(item) for key, item in value.items()}
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


def _scope_payload(scope_name: str, scope_data: Dict[str, Any], include_revenue: bool) -> Dict[str, Any]:
    monthly = scope_data["monthly"]
    return {
        "name": scope_name,
        "total": _as_json_compatible(scope_data["total"]),
        "priorTotal": _as_json_compatible(scope_data["prior_total"]),
        "yoy": _as_json_compatible(scope_data["yoy"]),
        "kpis": _as_json_compatible(scope_data["kpis"]),
        "monthlyTable": {
            "raw": _as_json_compatible(monthly),
            "formatted": _as_json_compatible(format_summary_table(monthly, include_revenue)),
        },
        "chartSeries": _scope_chart_series(monthly),
    }


def _scope_chart_series(monthly_df: pd.DataFrame) -> Dict[str, Any]:
    month_rows = monthly_df[monthly_df["Month"] != "Total"].copy()
    return {
        "costVsLeads": {
            "chartType": "combo",
            "x": month_rows["Month"].tolist(),
            "leftAxis": {
                "label": "Cost (£)",
                "series": [{"name": "Cost", "type": "bar", "values": _as_json_compatible(month_rows["Cost"].tolist())}],
            },
            "rightAxis": {
                "label": "Sales Leads",
                "series": [{"name": "Sales Leads", "type": "line", "values": _as_json_compatible(month_rows["Sales Leads"].tolist())}],
            },
        },
        "cplVsCvr": {
            "chartType": "combo",
            "x": month_rows["Month"].tolist(),
            "leftAxis": {
                "label": "CPL (£)",
                "series": [{"name": "CPL", "type": "line", "values": _as_json_compatible(month_rows["CPL"].tolist())}],
            },
            "rightAxis": {
                "label": "CVR (%)",
                "series": [
                    {
                        "name": "CVR",
                        "type": "line",
                        "values": _as_json_compatible((month_rows["CVR"] * 100).tolist()),
                    }
                ],
            },
        },
    }


def _mix_payload(mix_df: pd.DataFrame) -> Dict[str, Any]:
    rows = _as_json_compatible(mix_df)
    return {
        "table": rows,
        "charts": [
            {
                "chartType": "pie",
                "title": "Cost share",
                "labels": mix_df["Campaign Type"].tolist() if not mix_df.empty else [],
                "values": _as_json_compatible(mix_df["Cost"].tolist()) if not mix_df.empty else [],
                "valueColumn": "Cost",
            },
            {
                "chartType": "pie",
                "title": "Lead share",
                "labels": mix_df["Campaign Type"].tolist() if not mix_df.empty else [],
                "values": _as_json_compatible(mix_df["Sales Leads"].tolist()) if not mix_df.empty else [],
                "valueColumn": "Sales Leads",
            },
        ],
    }


def _trend_payload(summary: Dict[str, Any], label: str) -> Dict[str, Any]:
    comparison = summary.get("comparison", pd.DataFrame())
    return {
        "name": summary.get("name", label),
        "terms": summary.get("terms", []),
        "currentAverage": _as_json_compatible(summary.get("current_average")),
        "previousYearAverage": _as_json_compatible(summary.get("previous_year_average")),
        "yoyChange": _as_json_compatible(summary.get("yoy_change")),
        "peakMonths": summary.get("peak_months", []),
        "classification": summary.get("classification"),
        "bullets": generate_trend_bullets(summary, label),
        "chart": {
            "chartType": "line",
            "title": f"{label} Search Interest",
            "x": comparison["month_label"].tolist() if not comparison.empty else [],
            "series": [
                {
                    "name": "Current period",
                    "values": _as_json_compatible(comparison["current_value"].tolist()) if not comparison.empty else [],
                },
                {
                    "name": "Prior year",
                    "values": _as_json_compatible(comparison["prior_value"].tolist()) if not comparison.empty and "prior_value" in comparison else [],
                },
            ],
        },
    }


def _auction_payload(summary: Dict[str, Any] | None) -> Dict[str, Any] | None:
    if not summary:
        return None
    table = summary.get("table", pd.DataFrame())
    return {
        "competitorCount": summary.get("competitor_count"),
        "ourImpressionShare": _as_json_compatible(summary.get("our_impression_share")),
        "topOverlapCompetitors": _as_json_compatible(summary.get("top_overlap_competitors", [])),
        "topImpressionShareCompetitors": _as_json_compatible(summary.get("top_impression_share_competitors", [])),
        "topOutrankingCompetitors": _as_json_compatible(summary.get("top_outranking_competitors", [])),
        "bullets": generate_auction_bullets(summary),
        "table": _as_json_compatible(table),
    }


def _load_trends_summary(
    config_loader: ConfigLoader,
    client_config: Dict[str, Any],
    quarter: QuarterInfo,
    trends_dir: str | Path | None,
) -> Dict[str, Any] | None:
    brand_config = client_config.get("brand_trends", {})
    destination_config = client_config.get("destination_trends", {})
    if not brand_config.get("enabled") and not destination_config.get("enabled"):
        return None

    trends_df = TrendsLoader(trends_dir).load_from_directory(trends_dir)
    if trends_df.empty:
        return None

    summary = summarize_trends(
        trends_df=trends_df,
        quarter=quarter,
        brand_terms=brand_config.get("terms", []),
        destination_configs=destination_config.get("destinations", []),
        trend_aliases=client_config.get("trend_aliases", {}),
    )
    if not summary.get("brand") and not summary.get("destinations"):
        return None
    return summary


def _load_auction_summary(client_config: Dict[str, Any], auction_csv: str | Path | None) -> Dict[str, Any] | None:
    auction_config = client_config.get("auction_insights", {})
    if not auction_config.get("enabled") or not auction_csv:
        return None

    auction_df = load_auction_csv(auction_csv)
    return summarize_auction_insights(
        auction_df,
        client_domain=auction_config.get("client_domain"),
        known_competitors=auction_config.get("known_competitors"),
    )


def _build_slide_blueprint(
    *,
    client_name: str,
    report_title: str,
    agency_name: str,
    subtitle: str,
    report: Dict[str, Any],
    trends_summary: Dict[str, Any] | None,
    auction_summary: Dict[str, Any] | None,
    recommendations: List[Dict[str, str]],
    include_revenue: bool,
    max_scope_count: int,
) -> List[Dict[str, Any]]:
    slides: List[Dict[str, Any]] = [
        {
            "slideType": "title",
            "referenceLayout": "copy reference title slide; preserve background, typography, KPI card treatment",
            "title": client_name,
            "subtitle": report_title,
            "periodLabel": subtitle,
            "preparedBy": agency_name,
            "kpis": report["overall"]["kpis"][:4],
        },
        {
            "slideType": "section_divider",
            "referenceLayout": "copy Performance divider slide",
            "title": "Performance",
            "subtitle": f"{client_name} | {subtitle} | Summon",
        },
        {
            "slideType": "summary_kpis",
            "referenceLayout": "copy Overall Performance Trend KPI slide style",
            "title": "Overall Performance Trend",
            "subtitle": subtitle,
            "kpis": report["overall"]["kpis"],
            "bullets": generate_overall_bullets(report["overall"], report["mix_overall"]),
            "scope": _scope_payload("Overall", report["overall"], include_revenue),
        },
        {
            "slideType": "mix_chart",
            "referenceLayout": "copy Campaign Type Mix slide style",
            "title": "Campaign Type Mix",
            "subtitle": subtitle,
            "bullets": generate_mix_bullets(report["mix_overall"], "overall"),
            "mix": _mix_payload(report["mix_overall"]),
        },
    ]

    for campaign in list(report.get("available_campaigns", []))[:max_scope_count]:
        scope = report["campaigns"][campaign]
        slides.extend(
            [
                {
                    "slideType": "summary_kpis",
                    "referenceLayout": "copy campaign summary slide style",
                    "title": f"{campaign} Summary",
                    "subtitle": subtitle,
                    "kpis": scope["kpis"],
                    "bullets": generate_scope_bullets(campaign, scope),
                    "scope": _scope_payload(campaign, scope, include_revenue),
                },
                {
                    "slideType": "trend_chart",
                    "referenceLayout": "copy monthly trend chart slide style",
                    "title": f"{campaign} Monthly Trend",
                    "subtitle": subtitle,
                    "chartSeries": _scope_chart_series(scope["monthly"]),
                },
            ]
        )

    slides.append(
        {
            "slideType": "section_divider",
            "referenceLayout": "copy Destinations divider slide",
            "title": "Destinations",
            "subtitle": f"{client_name} | {subtitle} | Summon",
        }
    )

    for destination in list(report.get("available_destinations", []))[:max_scope_count]:
        scope = report["destinations"][destination]
        destination_slides = [
            {
                "slideType": "summary_kpis",
                "referenceLayout": "copy destination summary + YoY slide style",
                "title": f"{destination} Summary + YoY",
                "subtitle": subtitle,
                "kpis": scope["kpis"],
                "bullets": generate_scope_bullets(destination, scope),
                "scope": _scope_payload(destination, scope, include_revenue),
            },
            {
                "slideType": "trend_chart",
                "referenceLayout": "copy destination monthly trend slide style",
                "title": f"{destination} Monthly Trend",
                "subtitle": subtitle,
                "chartSeries": _scope_chart_series(scope["monthly"]),
            },
        ]
        if destination in report.get("dest_mix", {}):
            destination_slides.append(
                {
                    "slideType": "mix_chart",
                    "referenceLayout": "copy destination campaign mix slide style",
                    "title": f"{destination} Campaign Mix",
                    "subtitle": subtitle,
                    "bullets": generate_mix_bullets(report["dest_mix"][destination], destination),
                    "mix": _mix_payload(report["dest_mix"][destination]),
                }
            )
        slides.extend(destination_slides)

    if trends_summary and (trends_summary.get("brand") or trends_summary.get("destinations")):
        slides.append(
            {
                "slideType": "section_divider",
                "referenceLayout": "copy Google Trends divider slide",
                "title": "Google Trends",
                "subtitle": f"{client_name} | {subtitle} | Summon",
            }
        )
        if trends_summary.get("brand"):
            slides.append(
                {
                    "slideType": "external_trend_chart",
                    "referenceLayout": "copy brand demand trend slide style",
                    "title": f"{client_name} Terms Are Growing",
                    "subtitle": subtitle,
                    "sourceNote": "Source: Google Trends",
                    "trend": _trend_payload(trends_summary["brand"], "Brand"),
                }
            )
        for destination_summary in trends_summary.get("destinations", []):
            name = destination_summary.get("name", "Destination")
            slides.append(
                {
                    "slideType": "external_trend_chart",
                    "referenceLayout": "copy destination demand trend slide style",
                    "title": f"{name} Demand Trend",
                    "subtitle": subtitle,
                    "sourceNote": "Source: Google Trends",
                    "trend": _trend_payload(destination_summary, str(name)),
                }
            )

    if auction_summary:
        slides.extend(
            [
                {
                    "slideType": "section_divider",
                    "referenceLayout": "copy Auction Insights divider slide",
                    "title": "Auction Insights",
                    "subtitle": f"{client_name} | {subtitle} | Summon",
                },
                {
                    "slideType": "auction_table",
                    "referenceLayout": "copy Non-Brand Auction Insights slide style",
                    "title": "Non-Brand Auction Insights",
                    "subtitle": subtitle,
                    "sourceNote": "Source: Google Ads Auction Insights",
                    "auction": _auction_payload(auction_summary),
                },
            ]
        )

    if recommendations:
        slides.extend(
            [
                {
                    "slideType": "section_divider",
                    "referenceLayout": "copy Next Steps divider slide",
                    "title": "Next Steps",
                    "subtitle": f"{client_name} | {subtitle} | Summon",
                },
                {
                    "slideType": "recommendations",
                    "referenceLayout": "copy Next Steps for Q2 slide style",
                    "title": "Next Steps for Q2",
                    "subtitle": subtitle,
                    "recommendations": recommendations,
                },
            ]
        )

    return slides


def _renderer_instructions(reference_deck_url: str) -> List[str]:
    return [
        f"Copy the reference Google Slides deck first: {reference_deck_url}",
        "Do not generate a new blank PPTX for the final report.",
        "Preserve reference backgrounds, typography, spacing, section dividers, KPI-card style, footer, and colour system.",
        "Render charts as native Google Slides/Sheets charts or inserted chart images generated by a dedicated chart-rendering tool, not by this Python calculation compiler.",
        "Use the slide_blueprint order as the content plan, but reuse/duplicate matching reference slides wherever possible.",
        "When a slide cannot be confidently populated, leave a visible human-editable placeholder instead of inventing client commentary.",
        "All destructive actions require approval; creating a copied deck and adding a Notion memory page do not.",
    ]


def build_payload(args: argparse.Namespace) -> Dict[str, Any]:
    project_root = Path(__file__).resolve().parent
    input_csv = Path(args.input_csv).expanduser()
    if not input_csv.exists() or not input_csv.is_file():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")
    if args.max_scope_count <= 0:
        raise ValueError("--max-scope-count must be greater than 0.")

    config_loader = ConfigLoader(
        report_config_path=project_root / "config" / "report_config.yaml",
        chart_styles_path=project_root / "config" / "chart_styles.yaml",
        clients_config_path=project_root / "config" / "clients_config.json",
    )
    client_config = config_loader.get_client_config(args.client_id)
    df = load_csv(input_csv)
    quarter = _select_quarter(df, args.report_year, args.report_quarter)
    report = prepare_report_data(
        df,
        quarter,
        campaign_order=config_loader.get_campaign_types(client_config),
        destination_order=config_loader.get_destinations(client_config),
        destination_other_config=client_config.get("destination_other"),
    )
    validate_report_data(report)

    trends_summary = _load_trends_summary(config_loader, client_config, quarter, args.trends_dir)
    auction_summary = _load_auction_summary(client_config, args.auction_csv)
    recommendations = generate_recommendations(
        report,
        trends_summary=trends_summary,
        auction_summary=auction_summary,
    )

    client_name = config_loader.get_client_name(client_config)
    report_title = config_loader.get_report_title(client_config)
    agency_name = config_loader.get_agency_name(client_config)
    subtitle = f"{quarter.label} ({quarter.start.strftime('%b')} - {quarter.end.strftime('%b %Y')})"
    chart_styles = config_loader.get_chart_styles(client_config)

    return {
        "status": "ok",
        "mode": "calculation_blueprint",
        "version": 1,
        "input": {
            "sourceCsv": str(input_csv),
            "clientId": str(client_config["id"]),
            "clientName": client_name,
        },
        "reportTitle": report_title,
        "agencyName": agency_name,
        "referenceDeckUrl": REFERENCE_DECK_URL,
        "rowCount": len(df),
        "dateRange": {
            "min": _as_json_compatible(df["date"].min()),
            "max": _as_json_compatible(df["date"].max()),
        },
        "quarter": _as_json_compatible(quarter),
        "styleTokens": _as_json_compatible(chart_styles),
        "rendererInstructions": _renderer_instructions(REFERENCE_DECK_URL),
        "metrics": {
            "includeRevenue": report.get("include_revenue", False),
            "overall": _scope_payload("Overall", report["overall"], report["include_revenue"]),
            "campaigns": {
                name: _scope_payload(name, scope, report["include_revenue"])
                for name, scope in list(report["campaigns"].items())[: args.max_scope_count]
            },
            "destinations": {
                name: _scope_payload(name, scope, report["include_revenue"])
                for name, scope in list(report["destinations"].items())[: args.max_scope_count]
            },
            "mixOverall": _mix_payload(report["mix_overall"]),
            "destinationMix": {
                name: _mix_payload(mix_df)
                for name, mix_df in list(report.get("dest_mix", {}).items())[: args.max_scope_count]
            },
            "destinationExcludedTotal": _as_json_compatible(report.get("destination_excluded_total", {})),
            "availableCampaigns": list(report.get("available_campaigns", []))[: args.max_scope_count],
            "availableDestinations": list(report.get("available_destinations", []))[: args.max_scope_count],
        },
        "trends": _as_json_compatible(trends_summary),
        "auctionInsights": _auction_payload(auction_summary),
        "recommendations": recommendations,
        "slideBlueprint": _as_json_compatible(
            _build_slide_blueprint(
                client_name=client_name,
                report_title=report_title,
                agency_name=agency_name,
                subtitle=subtitle,
                report=report,
                trends_summary=trends_summary,
                auction_summary=auction_summary,
                recommendations=recommendations,
                include_revenue=report["include_revenue"],
                max_scope_count=args.max_scope_count,
            )
        ),
    }


def main() -> None:
    args = parse_args()
    try:
        payload = build_payload(args)
        output_json = Path(args.output_json).expanduser()
        output_json.parent.mkdir(parents=True, exist_ok=True)
        output_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(
            json.dumps(
                {
                    "status": "ok",
                    "mode": payload["mode"],
                    "output_json": str(output_json),
                    "client": payload["input"],
                    "quarter": payload["quarter"],
                    "slide_count": len(payload["slideBlueprint"]),
                    "row_count": payload["rowCount"],
                }
            )
        )
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        print(json.dumps({"status": "error", "error": "Python 3.10+ is required."}))
        raise SystemExit(1)
    main()
