import argparse
import csv
import json
import re
from pathlib import Path

import pdfplumber


EXCLUDED_COMPANIES = {
    "Prodrive",
    "JSR",
    "Applied Materials",
    "Amkor Technology",
    "Heraeus",
    "Toray",
    "3M",
    "Air Liquide",
    "Air Products",
}

PDF_COMPANY_FIXES = {
    "ShanghaPi oEwleectrric Wind": "Shanghai Electric Wind Power",
    "AustralMiaent aSltsrategic": "Australian Strategic Metals",
}

COMPANY_TECH_GROUPS = {
    "Cognex": "3d_vision_sensor",
    "Jenoptik": "3d_vision_sensor",
    "Heidenhain": "linear_scale",
    "Renishaw": "linear_scale",
    "Corning": "euv_blank_mask",
    "DNP": "fine_metal_mask",
    "Hitachi Metals": "fine_metal_mask",
    "Toppan Holdings": "fine_metal_mask",
    "ABB": "robot_reducer",
    "Maxon": "robot_reducer",
    "Nabtesco": "robot_reducer",
    "Schmalz": "robot_reducer",
    "Hexagon AB": "robot_lidar",
    "Ouster": "robot_lidar",
    "BorgWarner": "autonomous_imu_rf_baseband",
    "Qualcomm": "autonomous_imu_rf_baseband",
    "Skyworks": "autonomous_imu_rf_baseband",
    "Cheng Uei Precision": "autonomous_camera_isp",
    "Onsemi": "autonomous_camera_isp",
    "Prodrive": "autonomous_camera_isp",
    "Charles River": "virus_validation_mcb_wcb",
    "Texcell": "virus_validation_mcb_wcb",
    "Schott Pharma": "autoinjector_pfs_fill_finish",
    "West Pharmaceutical": "autoinjector_pfs_fill_finish",
    "Bayer": "pharma_excipient",
    "Merck": "pharma_excipient",
    "Cytiva": "bioprocess_culture_purification",
    "GE Healthcare": "bioprocess_culture_purification",
    "Thermo Fisher": "bioprocess_culture_purification",
    "Eli Lilly and Company": "gene_cell_therapy_delivery_gmp",
    "Moderna": "gene_cell_therapy_delivery_gmp",
    "ASML": "euv_lithography",
    "JSR": "euv_lithography",
    "Applied Materials": "hybrid_bonding_w2w",
    "Besi": "hybrid_bonding_w2w",
    "EVG": "hybrid_bonding_w2w",
    "Tokyo Electron": "hybrid_bonding_w2w",
    "Asahi Glass": "tgv_glass_substrate",
    "Plansee": "metal_target_ti_ta",
    "Tosoh": "metal_target_ti_ta",
    "Amkor Technology": "semiconductor_thermal_material",
    "DOW": "semiconductor_thermal_material",
    "Dupont": "ag_al_paste",
    "Heraeus": "ag_al_paste",
    "Shanghai Electric Wind Power": "offshore_wind_turbine",
    "Siemens-Gamesa": "offshore_wind_turbine",
    "Vestas": "offshore_wind_turbine",
    "Infineon": "satellite_radar_rf_semiconductor",
    "NXP": "satellite_radar_rf_semiconductor",
    "Airbus": "aerospace_electric_propulsion",
    "Boeing": "aerospace_electric_propulsion",
    "Magnix": "aerospace_electric_propulsion",
    "Safran": "aerospace_electric_propulsion",
    "Mitsubishi Chemical": "silicon_anode_sic",
    "Nexeon": "silicon_anode_sic",
    "EMM(Umicore)": "silicon_anode_sic",
    "Albemarle": "lithium_cathode_materials",
    "Umicore": "lithium_cathode_materials",
    "Rio Tinto": "lithium_cathode_materials",
    "Arkema": "pvdf",
    "Syensqo": "pvdf",
    "Sumitomo Chemical": "pvdf",
    "Toray": "pvdf",
    "Norsk Hydro": "nonferrous_scrap_recycling",
    "TIMET": "nonferrous_scrap_recycling",
    "Australian Strategic Metals": "rare_earth_magnet_recycling",
    "HyproMag": "rare_earth_magnet_recycling",
    "Shin-Etsu Chemicals": "rare_earth_magnet_recycling",
    "3M": "ion_exchange_membrane",
    "Air Liquide": "ion_exchange_membrane",
    "Chemours": "ion_exchange_membrane",
    "Veolia": "ion_exchange_membrane",
    "Evonik Industries": "precipitated_silica_tire",
    "Solvay": "precipitated_silica_tire",
    "Air Products": "hexamethylenediamine_hmd",
    "Asahi Kasei": "hexamethylenediamine_hmd",
    "BASF": "hexamethylenediamine_hmd",
}


def clean_cell(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def load_targets(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_keyword_labels(path):
    with open(path, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    return config["groups"]


def extract_pdf_rows(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        if not pdf.pages:
            raise ValueError("PDF has no pages")
        tables = pdf.pages[0].extract_tables()
    if not tables:
        raise ValueError("No table found in PDF")

    rows = []
    for index, row in enumerate(tables[0][2:], start=1):
        if not row or len(row) < 4:
            continue
        raw_company = clean_cell(row[2])
        if not raw_company:
            continue
        company = PDF_COMPANY_FIXES.get(raw_company, raw_company)
        rows.append(
            {
                "pdf_row_no": index,
                "pdf_sequence": clean_cell(row[0]),
                "industry": clean_cell(row[1]),
                "pdf_company": raw_company,
                "company": company,
                "raw_target_technology": clean_cell(row[3]),
            }
        )
    return rows


def write_csv(path, rows):
    fieldnames = [
        "target_no",
        "company",
        "industry",
        "target_technology",
        "technology_group",
        "excluded_from_relevance",
        "raw_target_technology",
        "pdf_company",
        "pdf_row_no",
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def main():
    parser = argparse.ArgumentParser(description="Build company-to-technology mapping from the reference PDF.")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--targets", default="data/target_companies.json")
    parser.add_argument("--keywords", default="config/technology_keywords.json")
    parser.add_argument("--out-json", default="data/company_technology_map.json")
    parser.add_argument("--out-csv", default="data/company_technology_map.csv")
    args = parser.parse_args()

    targets = load_targets(args.targets)
    labels = load_keyword_labels(args.keywords)
    pdf_rows = extract_pdf_rows(args.pdf)
    pdf_by_company = {row["company"]: row for row in pdf_rows}

    target_names = [target["company"] for target in targets]
    missing_in_pdf = [name for name in target_names if name not in pdf_by_company]
    extra_in_pdf = [row["company"] for row in pdf_rows if row["company"] not in set(target_names)]
    missing_group = [name for name in target_names if name not in COMPANY_TECH_GROUPS]

    if missing_in_pdf or extra_in_pdf or missing_group:
        raise SystemExit(
            json.dumps(
                {
                    "missing_in_pdf": missing_in_pdf,
                    "extra_in_pdf": extra_in_pdf,
                    "missing_group": missing_group,
                },
                ensure_ascii=False,
                indent=2,
            )
        )

    companies = []
    for target in targets:
        company = target["company"]
        group_id = COMPANY_TECH_GROUPS[company]
        group = labels[group_id]
        pdf_row = pdf_by_company[company]
        companies.append(
            {
                "target_no": target["target_no"],
                "company": company,
                "query_aliases": target.get("query_aliases", []),
                "industry": pdf_row["industry"],
                "target_technology": group["label_ko"],
                "target_technology_en": group["label_en"],
                "technology_group": group_id,
                "excluded_from_relevance": company in EXCLUDED_COMPANIES,
                "exclude_reason": "user_requested_exclusion" if company in EXCLUDED_COMPANIES else "",
                "raw_target_technology": pdf_row["raw_target_technology"],
                "pdf_company": pdf_row["pdf_company"],
                "pdf_row_no": pdf_row["pdf_row_no"],
                "pdf_sequence": pdf_row["pdf_sequence"],
            }
        )

    output = {
        "description": "Company-to-target-technology mapping extracted from the reference PDF and normalized for relevance filtering.",
        "source_pdf": str(Path(args.pdf)),
        "company_count": len(companies),
        "excluded_company_count": sum(1 for row in companies if row["excluded_from_relevance"]),
        "excluded_companies": sorted(EXCLUDED_COMPANIES),
        "companies": companies,
    }

    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out_json, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    write_csv(args.out_csv, companies)

    print(
        json.dumps(
            {
                "company_count": len(companies),
                "excluded_company_count": output["excluded_company_count"],
                "out_json": args.out_json,
                "out_csv": args.out_csv,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
