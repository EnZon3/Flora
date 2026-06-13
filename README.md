# Local Model Setup

Download the official PlantCLEF 2024 archive from:

https://zenodo.org/records/10848263

Then run from the repository root:

```powershell
python -m pip install -r requirements-local.txt
python models/setup_local_model.py "C:\path\to\PlantNet_PlantCLEF2024_pretrained_models_on_the_flora_of_south-western_europe.tar"
```

The installer extracts `model_best.pth.tar`, copies its class mapping, and
builds the current species-name mapping using the Pl@ntNet API key in `.env`.
All generated model assets live under `models/pretrained_models/` and are
excluded from Git.

The model covers roughly 7,806 vascular plant classes from southwestern Europe.
Coverage elsewhere is limited; use the Pl@ntNet API for global identification.
