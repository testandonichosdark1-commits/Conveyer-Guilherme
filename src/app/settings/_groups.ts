/**
 * Single source of truth for the settings form schema.
 *
 * Only settings relevant to the Pexels b-roll + ai33pro TTS pipeline are
 * surfaced here.
 */

export interface Field {
  key: string;
  label?: string;
  desc: string;
  examples?: string;
  required?: boolean;
  multiline?: boolean;
  /** Hard character cap enforced by the input/textarea (e.g. short hint fields). */
  maxLength?: number;
}

export interface Group {
  title: string;
  subtitle?: string;
  required?: boolean;
  fields: Field[];
}

export const ALL_GROUPS: Group[] = [
  {
    title: "Required API Keys",
    subtitle: "The bare minimum to run the pipeline. (Your VOICE key — ai33.pro or 69labs — lives in the Voice Over section below; set whichever one you have.)",
    required: true,
    fields: [
      {
        key: "GOOGLE_API_KEY",
        desc: "Powers scene splitting — Gemini reads your script and breaks it into individual scenes with visual prompts.",
        examples: "Get it free at https://aistudio.google.com/app/apikey (Create API key)",
        required: true,
      },
      {
        key: "PEXELS_API_KEY",
        desc: "Pexels API key — the source of all b-roll. Free tier: 200 requests/hour, 20 000/month per key.\n\nPRO TIP: You can paste MULTIPLE Pexels keys (one per line, or comma-separated) from different free accounts. The app rotates through them — when one hits its hourly limit, it switches to the next. With 5 keys you get 1000 req/hour, enough for huge videos (700+ scenes) in one shot. When ALL keys are exhausted, the app auto-waits on the one whose window refreshes soonest, then resumes — no manual restart needed.",
        examples: "Single key: pasted on one line  ·  Multiple keys: one per line (paste, Enter, paste, Enter, ...)",
        required: true,
        multiline: true,
      },
      {
        key: "PIXABAY_API_KEY",
        label: "Pixabay API key (optional — more footage)",
        desc: "A SECOND free stock library (video + photo, no attribution needed). When set, the app searches Pixabay ALONGSIDE Pexels for every scene and keeps whichever clip matches best. This is the main lever for 'more accurate / less random' footage — one library alone often just doesn't have the exact shot, so a second one dramatically widens coverage. Leave empty to use Pexels only.",
        examples: "Get it free at https://pixabay.com/api/docs/ (free account → your API key on that page)",
      },
      {
        key: "GROQ_API_KEY",
        label: "Groq API key (smooth voice)",
        desc: "Used by the smooth single-shot voiceover mode. The app records the whole narration in one take, then asks Groq to listen back and mark exactly where each scene's words land — so a sentence that spans two scenes is never cut in half. The FREE tier covers normal use (it's only used once per video, on a tiny downsampled copy of the audio). Leave empty only if you switch Voice mode to 'per-scene'.",
        examples: "Get it free at https://console.groq.com/keys (Create API Key)",
        required: true,
      },
    ],
  },
  {
    title: "Storage Location",
    subtitle: "Where the generated audio and final videos are saved on disk.",
    fields: [
      {
        key: "RUNS_OUTPUT_DIR",
        desc: "Absolute folder path for run outputs. Leave empty to use the default location inside your user profile (~/.conveyer-guilherme/runs).",
        examples: "Mac: /Users/you/Documents/Conveyer-Runs  ·  Windows: D:\\YouTube\\Conveyer-Runs",
      },
      {
        key: "FFMPEG_PATH",
        desc: "Absolute path to the FFmpeg binary. Only needed if FFmpeg is not in your system PATH.",
        examples: "Mac: /opt/homebrew/bin/ffmpeg  ·  Windows: C:\\ffmpeg\\bin\\ffmpeg.exe  ·  Leave empty if `ffmpeg` works in your terminal",
      },
    ],
  },
  {
    title: "Script Breakdown (Gemini)",
    subtitle: "Which Gemini model splits your script into scenes.",
    fields: [
      {
        key: "SCENE_SPLIT_MODEL",
        desc: "Specific Gemini model id. The `-latest` alias auto-tracks the current stable Flash.",
        examples: "gemini-flash-latest, gemini-2.5-flash, gemini-2.5-pro",
      },
    ],
  },
  {
    title: "Voice Over — ai33.pro (ElevenLabs / Kokoro) OR 69labs",
    subtitle: "Pick the voice engine and paste its key here. ai33.pro and 69labs serve the SAME ElevenLabs voices (two gateways — use whichever you have). ai33.pro ALSO offers Kokoro — a different, ~50% cheaper model with its OWN voices. The run log prints which engine is actually live (e.g. \"Voice engine: kokoro\") so you always see what's being used.",
    fields: [
      {
        key: "TTS_PROVIDER",
        label: "Voice engine — ai33pro / 69labs / kokoro",
        desc: "Which service + model generates the voice.\n\n• 'ai33pro' (default) — ElevenLabs voice via the ai33.pro proxy. Uses the ai33.pro key below.\n\n• '69labs' — the SAME ElevenLabs voice through the 69labs gateway. Uses the 69labs key below.\n\n• 'kokoro' — the Kokoro model on ai33.pro: ~50% cheaper, but a DIFFERENT voice set (NOT ElevenLabs). Uses the ai33.pro key. When you pick kokoro, set the voice field below to a Kokoro voice (e.g. af_heart).\n\nModel id / similarity don't apply to kokoro; speed DOES. SMART: if you fill only ONE of the ai33.pro / 69labs keys, ai33pro vs 69labs is auto-picked. Whichever engine ends up active is printed in the run log.",
        examples: "ai33pro (default)  ·  69labs  ·  kokoro (cheaper, Kokoro voices)",
      },
      {
        key: "AI33PRO_API_KEY",
        label: "ai33.pro key (for the ai33pro engine)",
        desc: "ai33.pro API key — cheaper ElevenLabs-voice proxy. Fill this if Voice engine = ai33pro. Set at least one of this / the 69labs key below.",
        examples: "Get it from your ai33.pro dashboard → API Key",
      },
      {
        key: "LABS69_API_KEY",
        label: "69labs key (for the 69labs engine)",
        desc: "69labs API key — same ElevenLabs voices through the 69labs gateway. Fill this if Voice engine = 69labs. The key starts with `vk_`. Set at least one of this / the ai33.pro key above.",
        examples: "vk_xxxxxxxxxxxxxxxx — from https://69labs.vip dashboard → API",
      },
      {
        key: "TTS_MODE",
        label: "Voice mode",
        desc: "How the narration is recorded.\n\n• 'single-shot' (recommended) records the WHOLE script in one continuous take, so the voice flows naturally and a sentence is never split in half when one scene ends and the next begins. Needs the Groq API key above.\n\n• 'per-scene' records each scene separately (the older way). Pick this only if you don't want to set up a Groq key — but expect a small pause at every scene change.",
        examples: "single-shot (recommended)  ·  per-scene",
      },
      {
        key: "TTS_VOICE_ID",
        label: "Voice id (ElevenLabs or Kokoro)",
        desc: "The narration voice. WHICH kind depends on the engine above:\n\n• ai33pro / 69labs (ElevenLabs) → an ElevenLabs voice id like KeU8nqWFDbaoi0QVUjD3. Paste just the ID; the ai33.pro dashboard shows them as 'elevenlabs_<id>' and the app strips that prefix for you.\n\n• kokoro → a Kokoro voice name like af_heart, am_adam, af_bella (af_ = female, am_ = male). The app adds the 'kokoro_' prefix automatically. Leave blank and it defaults to af_heart.\n\nA wrong id makes the service fall back to a DEFAULT voice (output won't match what you picked).",
        examples: "ElevenLabs: KeU8nqWFDbaoi0QVUjD3  ·  Kokoro: af_heart, am_adam, af_bella",
      },
      {
        key: "TTS_MODEL",
        label: "ElevenLabs model",
        desc: "ElevenLabs model id. `eleven_multilingual_v2` is the recommended default (good quality, multilingual). Use `eleven_turbo_v2_5` for faster/cheaper generation.",
        examples: "eleven_multilingual_v2 (default)  ·  eleven_turbo_v2_5  ·  eleven_monolingual_v1",
      },
      {
        key: "TTS_SPEED",
        label: "Voice speed",
        desc: "How fast the narration plays. 1.0 = normal. LOWER = slower, calmer voice (and because each scene lasts as long as its narration, a slower voice also makes the video change scenes more slowly). The pitch stays natural — it's not chipmunk/slow-mo, just paced. Try 0.9 if the voice feels rushed.",
        examples: "1.0 = normal  ·  0.9 = noticeably calmer (recommended if too fast)  ·  0.85 = slow/documentary",
      },
      {
        key: "MIN_SCENE_SECONDS",
        label: "Min seconds per shot",
        desc: "Smooth-voice mode only. The shortest time a single piece of footage stays on screen. Scenes whose narration is shorter than this are merged with the next one (keeping the first scene's footage), so the video doesn't 'jump' on every word — and a stray one-word line never gets its own off-topic clip. Together with 'Max seconds per b-roll clip' this keeps every shot in a calm 3–7s range.",
        examples: "3 = default (recommended)  ·  4 = calmer  ·  2 = snappier",
      },
      {
        key: "MAX_CLIP_SECONDS",
        label: "Max seconds per b-roll clip",
        desc: "Smooth-voice mode only. Keeps the picture moving: if a segment's narration runs longer than this, the app fetches SEVERAL different Pexels clips for it (each this many seconds) instead of stretching or freezing one clip. Lower = more visual variety, more Pexels usage. Set to 0 to use just one clip per segment no matter how long.",
        examples: "7 = default  ·  5 = livelier / more cuts  ·  0 = one clip per segment",
      },
      {
        key: "MAX_PAUSE_SECONDS",
        label: "Max pause between sentences (s)",
        desc: "Smooth-voice mode only — and THIS is the pause control for it. The voiceover is one continuous take, so gaps can only be shortened by trimming them afterwards. This caps every silence — the pauses between sentences, and the small gaps where a long script was voiced in pieces — to this many seconds. Shorter pauses are left alone (the rhythm stays natural); only the over-long gaps get trimmed. Lower = tighter, snappier narration. Set to 0 to keep the voice engine's raw pacing. NOTE: the 'Pause between scenes' setting further down does NOTHING in smooth-voice mode — this is the one that works.",
        examples: "0.6 = default  ·  0.4 = tighter  ·  0.3 = very snappy  ·  0 = off (raw pacing)",
      },
    ],
  },
  {
    title: "Stock Footage (Pexels)",
    subtitle: "Each scene gets one stock clip from Pexels matched against its visual prompt.",
    fields: [
      {
        key: "VIDEO_CONTEXT",
        label: "Video context (optional)",
        desc: "A short hint about WHERE the video takes place and its style — used to keep the footage on-theme. The app already reads your whole script and carries the setting forward on its own, so you can usually LEAVE THIS EMPTY. Fill it only when a video keeps pulling slightly off-topic clips, and keep it to ONE short sentence. Describe the place/world, not commands — e.g. a setting, not 'always show X'. (A long paste or a full prompt here will confuse the search, so it's length-capped on purpose.)",
        examples: "A frugal shopper inside a pharmacy and grocery store; realistic, everyday  ·  Appalachian homestead garden, weathered hands, natural light",
        multiline: true,
        maxLength: 300,
      },
      {
        key: "FOOTAGE_SOURCES",
        label: "Footage sources",
        desc: "Which libraries to search, comma-separated. The app queries ALL of them for each scene, pools every result, and the AI picks the best match — so more sources = better odds the right shot exists.\n\n• pexels, pixabay — video + photos, NO attribution needed (each needs its API key above; a keyless source is skipped).\n• openverse, wikimedia — huge CC IMAGE libraries (no key needed). They make 'photo' scenes much more accurate, BUT their images are Creative-Commons and REQUIRE crediting the author in your video description — the run log prints the author + source + license for every clip used.\n• archive — Internet-Archive CC video (opt-in; vintage/news/educational). Add it only if you want older footage.",
        examples: "pexels,pixabay,openverse,wikimedia (default)  ·  pexels,pixabay (no-attribution only)  ·  add ',archive' for vintage video",
      },
      {
        key: "OPENVERSE_TOKEN",
        label: "Openverse token (optional)",
        desc: "Optional. A free Openverse API token just raises the rate limit — Openverse works without it (anonymous). Only worth setting if you make a lot of videos and hit Openverse rate limits. Get one at api.openverse.org.",
        examples: "Leave empty unless you hit Openverse rate limits",
      },
      {
        key: "FOOTAGE_AI_PICK",
        label: "AI picks the best footage",
        desc: "When 'on', the app gathers candidate clips from all sources, then Gemini LOOKS AT each candidate's preview image and scores how well it fits this scene AND the whole video — and keeps the best match (it aims for a strong match, widening the search a few times, and only settles for a looser one if nothing better exists; a scene never ends up empty). The run log shows the chosen clip's match %.\n\n'off' = skip the AI look and use a simpler text keyword match instead (no Gemini calls). Needs the Google key; if Gemini is briefly unavailable it falls back to the text match automatically, so a run never fails.",
        examples: "on (default — looks at the actual footage)  ·  off (keyword match only)",
      },
      {
        key: "STOCK_FOOTAGE_ORIENTATION",
        label: "Orientation",
        desc: "Which clip orientations Pexels returns. `landscape` for 16:9 long-form YouTube. `portrait` for 9:16 Shorts/TikTok/Reels. `square` for 1:1.",
        examples: "landscape (default)  ·  portrait  ·  square",
      },
      {
        key: "STOCK_FOOTAGE_MAX_HEIGHT",
        label: "Max clip height (px)",
        desc: "Caps the resolution Pexels delivers. 1080 = good quality, modest file size. 2160 = 4K.",
        examples: "720  ·  1080 (default)  ·  2160",
      },
      {
        key: "STOCK_FOOTAGE_MIN_DURATION",
        label: "Min clip duration (seconds)",
        desc: "Filters out short stinger clips that don't have enough length to fill a scene.",
        examples: "4 (default)  ·  6 for longer narration  ·  0 = no filter",
      },
      {
        key: "SCENE_PHOTO_RATIO",
        label: "Photo / video mix (%)",
        desc: "Percentage of scenes that use a STILL PHOTO with smooth ken-burns zoom instead of a moving stock video. Mixing photos in adds visual variety and helps where Pexels has stronger photos than videos for a given query. 0 = only videos, 100 = only photos. Default 40.",
        examples: "0 = video only  ·  40 = balanced mix (default)  ·  100 = photos only",
      },
      {
        key: "SCENE_MIX_MODE",
        label: "Photo distribution",
        desc: "How photo scenes are picked across the timeline. `random` shuffles for unpredictable variety. `alternating` spreads photos evenly (predictable rhythm).",
        examples: "random (default)  ·  alternating",
      },
      {
        key: "IMAGE_RATIO",
        label: "Output aspect ratio",
        desc: "Aspect ratio of the FINAL video. Match this to your orientation setting above (landscape→16:9, portrait→9:16).",
        examples: "16:9 (default)  ·  9:16  ·  1:1",
      },
    ],
  },
  {
    title: "Video Assembly (FFmpeg)",
    subtitle: "Final stitching step.",
    fields: [
      {
        key: "VIDEO_RESOLUTION",
        desc: "Final video resolution. 1920x1080 (1080p) is the YouTube standard.",
        examples: "1920x1080, 1280x720, 3840x2160",
      },
      {
        key: "VIDEO_FPS",
        desc: "Frames per second. 24 is cinematic. 30 is YouTube standard. 60 doubles render time.",
        examples: "24, 30, 60",
      },
      {
        key: "TRANSITION_MIN",
        label: "Transition length — min (s)",
        desc: "The transition is always a clean crossfade. Its LENGTH is randomized per scene change between this minimum and the maximum below — so the pacing feels varied and dynamic instead of every cut being identical. This is the shortest (snappiest) a cut can be.",
        examples: "0.3 = default  ·  0.2 = snappier",
      },
      {
        key: "TRANSITION_MAX",
        label: "Transition length — max (s)",
        desc: "The longest a single crossfade can be. Keep it modest (≤ ~1s) so the viewer never sits through a slow blend. Set min = max for identical transitions everywhere. Set max = 0 for instant hard cuts (no crossfade).",
        examples: "0.7 = default  ·  1.0 = a touch more cinematic  ·  0 = hard cuts",
      },
      {
        key: "SCENE_TAIL_SILENCE",
        label: "Pause between scenes (per-scene mode only)",
        desc: "ONLY applies when Voice mode = per-scene. It adds silence at the end of each separately-recorded scene. In the recommended single-shot (Groq) mode the narration is one continuous take with no scene-by-scene audio boundaries, so this setting does NOTHING there — pace single-shot videos with Voice speed instead.",
        examples: "per-scene: 0.4 = natural (default) · 0.8–1.2 = slower  ·  single-shot: no effect",
      },
      {
        key: "SCENE_DURATION_SECONDS",
        desc: "Fallback clip duration when TTS audio length is somehow unknown.",
        examples: "default 5",
      },
    ],
  },
  {
    title: "On-Screen Text (hook emphasis)",
    subtitle: "Optionally flash a big caption on screen when the narration hits a striking number, year, money amount, percentage, or place — like \"$400\" or \"1998\". The app detects these automatically from the script. To avoid clutter it's limited to the opening of the video by default.",
    fields: [
      {
        key: "TEXT_OVERLAY_MODE",
        label: "When to show captions",
        desc: "• 'hook' (default) — only in the first seconds of the video (set below), where punchy on-screen numbers lift retention without getting noisy.\n\n• 'all' — anywhere a striking number/year/place is spoken across the whole video.\n\n• 'off' — never show captions.\n\nThe text fades in and out, centered low on the frame, and is timed to the moment the word is spoken (smooth-voice mode). At most 4 captions are shown so it never feels spammy.",
        examples: "hook (default)  ·  all  ·  off",
      },
      {
        key: "TEXT_OVERLAY_HOOK_SECONDS",
        label: "Hook length (seconds)",
        desc: "Only used when the mode above is 'hook'. Captions appear only for words spoken within this many seconds from the start.",
        examples: "30 = default  ·  15 = just the very opening  ·  60 = first minute",
      },
      {
        key: "TEXT_OVERLAY_FONT",
        label: "Caption font (optional)",
        desc: "Absolute path to a bold .ttf/.otf font for the captions. Leave EMPTY to auto-pick a bold system font (Impact / Arial Black on Windows, Arial Bold / Impact on Mac). Set this only if you want a specific look or the auto-pick can't find a font.",
        examples: "Windows: C:\\Windows\\Fonts\\impact.ttf  ·  Mac: /Library/Fonts/YourFont.ttf  ·  empty = auto",
      },
    ],
  },
  {
    title: "Performance (Concurrency)",
    subtitle: "How many parallel jobs and FFmpeg renders to run at once.",
    fields: [
      {
        key: "TTS_CONCURRENCY",
        desc: "Simultaneous ai33pro TTS tasks.",
        examples: "default 3",
      },
      {
        key: "ANIMATION_CONCURRENCY",
        desc: "Simultaneous Pexels searches + downloads. The app handles rate limits automatically (rotates between PEXELS_API_KEY entries, auto-waits when all are exhausted), so 5 is safe even for huge videos. Raise to 8-10 if you have 3+ Pexels keys configured.",
        examples: "default 5  ·  8-10 with multiple keys",
      },
      {
        key: "ASSEMBLE_CONCURRENCY",
        desc: "How many FFmpeg clip renders happen in parallel. CPU-bound — set roughly to half your CPU core count.",
        examples: "default 4",
      },
    ],
  },
  {
    title: "Reliability",
    subtitle: "How tolerant a run is of failures.",
    fields: [
      {
        key: "FAILURE_THRESHOLD_PERCENT",
        desc: "If more than this percentage of scenes fail, the whole run aborts. Default 25.",
        examples: "25 = default (strict)  ·  60-70 = tolerant  ·  100 = never abort",
      },
    ],
  },
];
