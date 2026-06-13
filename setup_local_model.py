import argparse
import json
import os
import tarfile
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


MODEL_NAME = (
    "vit_base_patch14_reg4_dinov2_lvd142m_pc24_onlyclassifier_then_all"
)
ARCHIVE_ROOT = "pretrained_models"
EXTRACTED_ROOT = Path(__file__).parent / "pretrained_models"
CLASS_MAPPING_MEMBER = f"{ARCHIVE_ROOT}/class_mapping.txt"
CHECKPOINT_MEMBER = f"{ARCHIVE_ROOT}/{MODEL_NAME}/model_best.pth.tar"
ARGS_MEMBER = f"{ARCHIVE_ROOT}/{MODEL_NAME}/args.yaml"
SUMMARY_MEMBER = f"{ARCHIVE_ROOT}/{MODEL_NAME}/summary.csv"
PROJECTS = ("k-southwestern-europe", "k-world-flora")


def read_env_key():
    env_path = Path(__file__).parent.parent / ".env"
    if not env_path.is_file():
        return None
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("PLANTNET_API_KEY="):
            return line.partition("=")[2].strip()
    return None


def extract_member(archive, member_name):
    source = archive.extractfile(member_name)
    if source is None:
        raise FileNotFoundError(f"Archive member not found: {member_name}")
    relative = Path(member_name).relative_to(ARCHIVE_ROOT)
    destination = EXTRACTED_ROOT / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source, destination.open("wb") as target:
        while chunk := source.read(1024 * 1024):
            target.write(chunk)
    print(f"Extracted {destination.relative_to(Path.cwd())}")


def fetch_species_page(api_key, project, page):
    query = urlencode(
        {
            "api-key": api_key,
            "pageSize": 10000,
            "page": page,
            "lang": "en",
        }
    )
    request = Request(
        f"https://my-api.plantnet.org/v2/projects/{project}/species?{query}",
        headers={"User-Agent": "flora-local-model-setup/1.0"},
    )
    with urlopen(request, timeout=120) as response:
        return json.load(response)


def species_record(species):
    return {
        "scientificName": species.get("scientificNameWithoutAuthor")
        or "Unknown species",
        "commonNames": species.get("commonNames") or [],
        "family": species.get("family") or "Unknown",
    }


def build_species_mapping(api_key):
    class_mapping_path = EXTRACTED_ROOT / "class_mapping.txt"
    class_ids = [
        line.strip()
        for line in class_mapping_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    wanted = set(class_ids)
    mapping = {}

    for project in PROJECTS:
        page = 1
        while wanted - mapping.keys():
            species_page = fetch_species_page(api_key, project, page)
            if not species_page:
                break
            for species in species_page:
                species_id = str(species.get("id", ""))
                if species_id in wanted:
                    mapping[species_id] = species_record(species)
            print(
                f"{project} page {page}: "
                f"{len(mapping)}/{len(class_ids)} classes mapped"
            )
            if len(species_page) < 10000:
                break
            page += 1

    ordered = {
        species_id: mapping[species_id]
        for species_id in class_ids
        if species_id in mapping
    }
    missing = [species_id for species_id in class_ids if species_id not in mapping]
    mapping_path = EXTRACTED_ROOT / "species_id_to_name.json"
    missing_path = EXTRACTED_ROOT / "unmapped_species_ids.txt"
    mapping_path.write_text(
        json.dumps(ordered, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    missing_path.write_text("\n".join(missing), encoding="utf-8")
    print(f"Wrote {len(ordered)} species names to {mapping_path}")
    if missing:
        print(
            f"{len(missing)} historical IDs are no longer present in current "
            "Pl@ntNet catalogs; inference skips those IDs."
        )


def main():
    parser = argparse.ArgumentParser(
        description="Install the optional PlantCLEF local model."
    )
    parser.add_argument("archive", type=Path, help="Path to the downloaded .tar file")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("PLANTNET_API_KEY") or read_env_key(),
        help="Pl@ntNet API key; defaults to PLANTNET_API_KEY or the project .env",
    )
    args = parser.parse_args()

    if not args.archive.is_file():
        parser.error(f"Archive not found: {args.archive}")
    if not args.api_key:
        parser.error("PLANTNET_API_KEY is required to build the species mapping")

    with tarfile.open(args.archive, "r") as archive:
        for member in (
            CLASS_MAPPING_MEMBER,
            CHECKPOINT_MEMBER,
            ARGS_MEMBER,
            SUMMARY_MEMBER,
        ):
            extract_member(archive, member)

    build_species_mapping(args.api_key)
    print("Local model setup complete. Restart the Node server.")


if __name__ == "__main__":
    main()
