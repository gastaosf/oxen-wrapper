# Seedance Studio

A small local web app for generating videos with **ByteDance Seedance 2.5** through the
**Oxen.ai inference API**. Node + TypeScript + Express backend, plain HTML/JS dark UI.
Your API key stays on the server; the browser only talks to `localhost`.

## Features

- Five modes mapped to the three documented Seedance 2.5 models:
  - Text to video → `bytedance-seedance-2-5-text-to-video`
  - Image to video (start frame + optional end frame) → `bytedance-seedance-2-5-image-to-video`
  - Reference to video (images, videos, audio) → `bytedance-seedance-2-5-reference-to-video`
  - Video extend / Video edit → reference-to-video with `omni_reference_task_type: extend | edit`
- All documented controls: aspect ratio, duration (auto or 4 to 30 s), resolution (480p/720p/1080p),
  audio on/off, output format (mp4/mov), watermark, and **draft mode** (480p preview, then a
  one-click 1080p final from the stored `draft_task_id`). `seed` appears only when the model's live
  `request_schema` lists it.
- Uploads with previews. Seedance takes media as URLs, so files are uploaded to an Oxen repository
  you own and referenced from there. You can also paste any public URL.
- Async jobs via `POST /api/ai/queue`, polled server-side with backoff (5 s → 30 s). Polling runs on
  the server, so it survives page refreshes and restarts. Many jobs can run at once.
- Finished videos are downloaded to `./outputs` and served locally, because provider URLs expire.
- History in `./data/jobs.json` with mode filter, delete, copy settings, load settings, regenerate.
- Cost estimate before submitting (from the model's `pricing`), per-job charged cost after it
  finishes, and total spend in the header (from `GET /api/ai/generations`).
- Provider error messages are shown verbatim, including `error_source`, provider code and
  whether the failure is retryable.

## Setup

Requirements: Node 20 or newer.

```bash
npm install
cp .env.example .env
# edit .env
```

`.env`:

| Variable | Required | Purpose |
|---|---|---|
| `PROVIDER_API_KEY` | yes | Oxen.ai API key from https://oxen.ai/settings/profile |
| `OXEN_UPLOAD_NAMESPACE` | for uploads | Your Oxen username (or org). Uploaded media goes into a repo here. |
| `OXEN_UPLOAD_REPO` | for uploads | Repo name, default `seedance-uploads`. Created on first upload as **public** so the model provider can fetch the files. |
| `OXEN_COMMIT_NAME` / `OXEN_COMMIT_EMAIL` | no | Author recorded on upload commits. |
| `TARGET_NAMESPACE` | no | Bill and store generations under an organization instead of your user. |
| `PORT` | no | Default `3210`. |

Without `OXEN_UPLOAD_NAMESPACE`, uploads are disabled and you paste public URLs instead.

## Run

```bash
npm run dev      # auto-restarts on server changes
# or
npm start
```

Open http://localhost:3210.

## Layout

```
server/index.ts          Express routes (/api/*), static files
server/lib/provider.ts   ALL Oxen/Seedance specifics: models, limits, request building,
                         queue/poll/cancel, pricing, spend, uploads, result download
server/lib/jobs.ts       job lifecycle, backoff polling, download to /outputs
server/lib/store.ts      JSON file store (data/jobs.json)
server/lib/config.ts     env + error type
public/                  index.html, app.js, styles.css (no build step)
outputs/                 downloaded videos (served at /outputs)
uploads/                 local copies of uploaded media for previews (served at /uploads)
```

To swap providers or models, replace `server/lib/provider.ts` and keep its exports.

## Provider endpoints used

| Call | Purpose |
|---|---|
| `POST /api/ai/queue` | enqueue a generation |
| `GET /api/ai/queue/:generation_id` | poll status, `videos[]`, `result_url`, error fields |
| `DELETE /api/ai/queue/:generation_id` | cancel |
| `GET /api/ai/models/:id` | pricing + `request_schema` |
| `GET /api/ai/generations?media_type=video&page_size=1` | `total_cost` for the header |
| `GET /api/ai/generations/:id` | charged `cost` of a finished job |
| `POST /api/repos` | create the upload repo (409 if it exists) |
| `PUT /api/repos/{ns}/{repo}/file/main/uploads` | multipart upload (`files[]`, `message`, `name`, `email`) |
| `GET /api/repos/{ns}/{repo}/file/main/uploads/<file>` | public URL handed to the model |

## Ambiguities in the docs and how they were handled

1. **No credits/balance endpoint.** The header shows total spend from `GET /api/ai/generations`
   (`total_cost`) instead of a remaining balance.
2. **Cost estimate math.** The docs list `cost_per_second`, `cost_per_second_with_audio` and
   `cost_per_second_high_res` without saying how they combine. The live model object additionally
   returns `cost_per_second_by_resolution` (`480p`/`720p`/`1080p`), which the estimate uses first;
   the documented fields are the fallback. Duration `auto` shows a 4 to 30 s range. The actual
   charged `cost` is shown on the job once it finishes.
3. **`seed`.** The queue request schema and the Seedance 2.0 page document `seed`, but the
   Seedance 2.5 parameter tables do not. The UI shows the seed field only if the model's live
   `request_schema` contains `seed`.
4. **Media must be URLs.** Seedance 2.5 takes `input_image`, `input_images`, etc. as URIs. The
   documented way to host a file on Oxen is the repository upload endpoint, so uploads go to a
   public repo in your namespace. The docs' own examples use `hub.oxen.ai/api/repos/.../file/main/...`
   URLs in exactly this way.
5. **Video extend / edit.** There is no separate Seedance model for these. The reference-to-video
   page documents `omni_reference_task_type: edit | extend`, which "need a reference video and
   match the video's aspect ratio", so these modes hide aspect ratio, require a video, and default
   the output format to `mov` as the docs recommend.
6. **Reference media size limits.** The 2.5 pages give counts and durations but only a size limit
   for images (30 MB). Video/audio formats (MP4/MOV, MP3/WAV) are taken from the Seedance 2.0
   reference page; the server caps uploads at 200 MB per file.
7. **Face flags.** Media that shows people goes to `input_face_images` / `input_face_videos`
   (and `input_image_has_face` / `tail_image_url_has_face` for image-to-video). The UI exposes
   this as a per-file "face" checkbox because the docs say content filters may block the request
   otherwise.
8. **`result_url` vs `videos[]`.** The docs say `videos[]` is the standard going forward; the
   poller reads `videos[0].url` first and falls back to `result_url`. An empty `videos` list on a
   `succeeded` generation is treated as not ready yet.
9. **Negative prompt** is not documented for Seedance 2.5, so there is no such field.
10. **Draft finals** send only `model` + `draft_task_id`, as documented. Settings shown on a
    final job are copied from the draft because the provider echoes whatever was sent, not what
    was rendered.
11. **Prompt media references.** The docs say `@Image1`, `@Video1`, `@Audio1`; the live schema's
    workbench hint uses `[Image 1]`, `[Video 1]`, `[Audio 1]`. The UI hint mentions both; the
    prompt is passed through untouched.
12. **Video edit length.** The live schema locks `duration` to `auto` when
    `omni_reference_task_type` is `edit`, so the edit mode hides the duration control and does not
    send `duration`. Extend and edit also lock `aspect_ratio` to `adaptive`, so it is not sent.
