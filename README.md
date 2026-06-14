# flora.

A camera-first plant identifier with environmental growing context.

The app can identify plants through the Pl@ntNet API or an optional local
PlantCLEF 2024 ViT-DINOv2 model. After identification, it can use browser
geolocation to summarize weather, soil, air quality, hardiness zone, planting
months, and local compatibility.

## Features

- Pl@ntNet image identification
- Optional local PlantCLEF inference
- Trefle edibility and growth metadata
- Open-Meteo weather, AQI, and seasonal climate
- SoilGrids soil properties and classification
- USDA hardiness-zone lookup with climate fallback
- Responsive, framework-free frontend

## Requirements

- Node.js 18 or newer
- A free [Pl@ntNet API key](https://my.plantnet.org/)
- A free [Trefle token](https://trefle.io/) for enrichment
- Python 3.10 or newer only if using the local model

## Quick Start

```powershell
git clone <your-repository-url>
cd mawli_hackathon
npm install
Copy-Item .env.example .env
```

Add your credentials to `.env`:

```env
PLANTNET_API_KEY=your_key
TREFLE_TOKEN=your_token
PORT=3000
```

Start the server:

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Optional Local Model

The 1.48 GB model checkpoint is intentionally excluded from Git.
The inference code in `models/infer.py` is committed; only generated/downloaded
files under `models/pretrained_models/` are ignored.

1. Download the PlantCLEF archive from the
   [official Zenodo record](https://zenodo.org/records/10848263).
2. Install the Python runtime:

```powershell
python -m pip install -r requirements-local.txt
```

3. Extract and configure the model:

```powershell
python models/setup_local_model.py "C:\path\to\PlantNet_PlantCLEF2024_pretrained_models_on_the_flora_of_south-western_europe.tar"
```

The setup command reads `PLANTNET_API_KEY` from `.env`, extracts only the
fully fine-tuned checkpoint, and builds the current species-name mapping.
Restart the Node server afterward. CPU inference can take around 15-20 seconds
per image.

In a GitHub Codespace or another fresh deployment, run the same model setup
command inside that environment. The checkpoint installed on your own computer
is not uploaded with the repository.

## API Routes

- `GET /health`
- `POST /identify/plantnet`
- `POST /identify/local`
- `POST /environment`

Image uploads must be JPEG or PNG and no larger than 10 MB.

## Checks

```powershell
npm run check
python -m py_compile models/infer.py models/setup_local_model.py
```

## Safety

Plant identification and edibility information are informational only. Never
consume a wild plant without verification from a qualified local expert.
