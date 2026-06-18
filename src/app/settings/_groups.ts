/**
 * Single source of truth for the settings form schema.
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
    subtitle: "The minimum keys needed for script splitting, stock footage, voice alignment, and b-roll scoring.",
    required: true,
    fields: [
      {
        key: "GOOGLE_API_KEY",
        desc: "Google Gemini API key. Used for Gemini scene splitting when selected, and also for Gemini Vision scoring when AI picks the best footage is on.",
        examples: "Get it at https://aistudio.google.com/app/apikey",
        required: true,
      },
      {
        key: "PEXELS_API_KEY",
        desc: "Pexels API key. You can paste multiple keys, one per line or comma-separated. The app rotates through them when rate limits are hit.",
        examples: "Single key or multiple keys, one per line",
        required: true,
        multiline: true,
      },
      {
        key: "PIXABAY_API_KEY",
        label: "Pixabay API key (optional)",
        desc: "Optional Pixabay API key. When set, the app searches Pixabay alongside Pexels for more video and photo candidates.",
        examples: "Get it at https://pixabay.com/api/docs/",
      },
      {
        key: "GROQ_API_KEY",
        label: "Groq API key (Whisper alignment)",
        desc: "Used in single-shot voice mode to align the continuous voiceover to scene boundaries with word timestamps.",
        examples: "Get it at https://console.groq.com/keys",
        required: true,
      },
    ],
  },
  {
    title: "Storage Location",
    subtitle: "Where generated audio, assets, and final videos are saved.",
    fields: [
      {
        key: "RUNS_OUTPUT_DIR",
        desc: "Absolute folder path for run outputs. Leave empty to use the default app data folder.",
        examples: "Mac: /Users/you/Documents/Conveyer-Runs · Windows: D:\\YouTube\\Conveyer-Runs",
      },
      {
        key: "FFMPEG_PATH",
        desc: "Absolute path to ffmpeg. Only needed if ffmpeg is not in your system PATH.",
        examples: "Mac: /opt/homebrew/bin/ffmpeg · Windows: C:\\ffmpeg\\bin\\ffmpeg.exe",
      },
    ],
  },
  {
    title: "Script Breakdown (LLM Provider)",
    subtitle: "Configure which LLM provider and model splits your script into scenes.",
    fields: [
      {
        key: "SCENE_SPLIT_PROVIDER",
        label: "LLM Provider",
        desc: "Provider used for splitting scripts into scenes. Use gemini for Google Gemini, or openai for OpenAI-compatible providers like DeepSeek/OpenRouter/OpenAI.",
        examples: "gemini · openai",
      },
      {
        key: "SCENE_SPLIT_MODEL",
        label: "Model ID",
        desc: "Model identifier for the selected scene split provider.",
        examples: "Gemini: gemini-flash-latest · DeepSeek: deepseek-v4-flash, deepseek-v4-pro",
      },
      {
        key: "OPENAI_API_KEY",
        label: "OpenAI-compatible API key",
        desc: "API key for the OpenAI-compatible scene split provider. Required when LLM Provider is openai.",
        examples: "DeepSeek/OpenAI/OpenRouter key",
      },
      {
        key: "OPENAI_BASE_URL",
        label: "Custom API Base URL",
        desc: "Base URL for the OpenAI-compatible provider.",
        examples: "DeepSeek: https://api.deepseek.com · OpenRouter: https://openrouter.ai/api/v1",
      },
    ],
  },
  {
    title: "Voice Over — TTS",
    subtitle: "Choose the narration engine and voice settings.",
    fields: [
      {
        key: "TTS_PROVIDER",
        label: "Voice engine",
        desc: "Voice engine used for narration.",
        examples: "ai33pro · 69labs · kokoro · minimax · minimax-ai33pro",
      },
      {
        key: "AI33PRO_API_KEY",
        label: "ai33.pro key",
        desc: "ai33.pro API key. Used for ai33pro, kokoro, and minimax-ai33pro engines.",
        examples: "Paste locally only; never commit API keys.",
      },
      {
        key: "LABS69_API_KEY",
        label: "69labs key",
        desc: "69labs API key. Used only when Voice engine is 69labs.",
        examples: "vk_...",
      },
      {
        key: "MINIMAX_API_KEY",
        label: "MiniMax key",
        desc: "MiniMax official API key. Used only when Voice engine is minimax.",
        examples: "Paste locally only; never commit API keys.",
      },
      {
        key: "MINIMAX_GROUP_ID",
        label: "MiniMax Group ID",
        desc: "MiniMax Group ID, if required by your account.",
        examples: "GroupId from your MiniMax dashboard",
      },
      {
        key: "MINIMAX_MODEL",
        label: "MiniMax model",
        desc: "MiniMax TTS model.",
        examples: "speech-02-hd · speech-02-turbo",
      },
      {
        key: "TTS_MODE",
        label: "Voice mode",
        desc: "single-shot records one continuous voiceover and aligns it with Whisper. per-scene records each scene separately.",
        examples: "single-shot · per-scene",
      },
      {
        key: "TTS_VOICE_PROVIDER",
        label: "Voice provider path",
        desc: "Voice provider path for engines that support multiple backends.",
        examples: "elevenlabs · edgetts · voice-clone",
      },
      {
        key: "TTS_VOICE_ID",
        label: "Voice id",
        desc: "Narration voice id or voice name, depending on the selected engine.",
        examples: "ElevenLabs id · Kokoro voice · MiniMax voice",
      },
      {
        key: "TTS_MODEL",
        label: "TTS model",
        desc: "Model id for ElevenLabs-compatible engines.",
        examples: "eleven_multilingual_v2 · eleven_turbo_v2_5",
      },
      {
        key: "TTS_SPEED",
        label: "Voice speed",
        desc: "Playback tempo. Lower values create a calmer, slower narration.",
        examples: "1.0 normal · 0.9 calmer · 0.85 slower",
      },
      {
        key: "MIN_SCENE_SECONDS",
        label: "Min seconds per shot",
        desc: "Single-shot mode only. Shortest time a visual stays on screen before scenes are merged.",
        examples: "3 default · 4 calmer · 2 snappier",
      },
      {
        key: "MAX_CLIP_SECONDS",
        label: "Max seconds per b-roll clip",
        desc: "Single-shot mode only. Long visual segments are split into clips up to this many seconds.",
        examples: "7 default · 12 batch · 0 disable split",
      },
      {
        key: "MAX_PAUSE_SECONDS",
        label: "Max pause between sentences",
        desc: "Single-shot mode only. Caps long silences in the continuous voiceover after TTS generation.",
        examples: "0.6 default · 0.4 tighter · 0 off",
      },
    ],
  },
  {
    title: "AI Host — HeyGen",
    subtitle: "Optional avatar host segments. The first implementation stores configuration only; the generation service comes next.",
    fields: [
      {
        key: "HEYGEN_MODE",
        label: "HeyGen mode",
        desc: "Controls HeyGen usage. off disables it. host_segments will later insert short avatar-host clips. full_host is reserved for future use.",
        examples: "off (default) · host_segments · full_host",
      },
      {
        key: "HEYGEN_API_KEY",
        label: "HeyGen API key",
        desc: "Your HeyGen API key. Store it only locally in Settings or .env. Never commit real API keys to GitHub.",
        examples: "Create a new key in HeyGen, then paste it locally here.",
      },
      {
        key: "HEYGEN_AVATAR_ID",
        label: "HeyGen Avatar ID",
        desc: "Avatar ID to use for host/avatar video segments.",
        examples: "Example format: 8b1bf31bcd6b40be8dee724ef620c543",
      },
      {
        key: "HEYGEN_VOICE_ID",
        label: "HeyGen Voice ID",
        desc: "Voice ID to use for HeyGen host/avatar segments.",
        examples: "Example format: f4b965c309494dcdb6b8f475bf8e839c",
      },
      {
        key: "HEYGEN_ASPECT_RATIO",
        label: "HeyGen aspect ratio",
        desc: "Aspect ratio for generated HeyGen clips.",
        examples: "16:9 (default) · 9:16 · 1:1",
      },
      {
        key: "HEYGEN_OUTPUT_FORMAT",
        label: "HeyGen output format",
        desc: "Output format for HeyGen clips.",
        examples: "mp4 (default)",
      },
      {
        key: "HEYGEN_CACHE",
        label: "HeyGen cache",
        desc: "When on, previously generated HeyGen clips can be reused instead of generated again.",
        examples: "on (default) · off",
      },
    ],
  },
  {
    title: "Stock Footage (Pexels/Pixabay)",
    subtitle: "How the app searches and picks stock video/photo b-roll.",
    fields: [
      {
        key: "VIDEO_CONTEXT",
        label: "Video context (optional)",
        desc: "Short background hint about the setting/style of the video. Leave empty unless footage keeps going off-theme.",
        examples: "Amish farmhouse kitchen, realistic warm light",
        multiline: true,
        maxLength: 300,
      },
      {
        key: "FOOTAGE_SOURCES",
        label: "Footage sources",
        desc: "Comma-separated stock libraries to search.",
        examples: "pexels,pixabay · pexels",
      },
      {
        key: "FOOTAGE_AI_PICK",
        label: "AI picks the best footage",
        desc: "When on, Gemini Vision looks at candidate preview images and scores visual fit. If unavailable, the app falls back to text score.",
        examples: "on · off",
      },
      {
        key: "GEMINI_VISION_MODEL",
        label: "Gemini Vision Model",
        desc: "Gemini model used only for visual scoring of candidate thumbnails. Separate from the Script Breakdown model.",
        examples: "gemini-flash-latest · gemini-2.5-flash",
      },
      {
        key: "PRODUCTION_MODE",
        label: "Production Mode",
        desc: "quality uses more search/vision for best matches. balanced is default. batch uses conservative limits and cache for bulk production.",
        examples: "quality · balanced · batch",
      },
      {
        key: "FOOTAGE_SEARCH_ATTEMPTS",
        label: "Footage Search Attempts",
        desc: "Number of search attempts per scene/clip before accepting the best available match.",
        examples: "3 default · 2 batch",
      },
      {
        key: "VISION_CONCURRENCY",
        label: "Vision Concurrency",
        desc: "Max parallel Gemini Vision calls.",
        examples: "2 default · 1 batch",
      },
      {
        key: "VISION_CANDIDATE_LIMIT",
        label: "Vision Candidate Limit",
        desc: "Max number of candidates sent to Gemini Vision per scene.",
        examples: "8 default · 6 batch",
      },
      {
        key: "VISION_COOLDOWN_ON_429_SEC",
        label: "Vision Cooldown on 429",
        desc: "Cooldown seconds after Gemini Vision hits rate limit.",
        examples: "120 default",
      },
      {
        key: "STOCK_FOOTAGE_ORIENTATION",
        label: "Orientation",
        desc: "Preferred stock footage orientation.",
        examples: "landscape · portrait · square",
      },
      {
        key: "STOCK_FOOTAGE_MAX_HEIGHT",
        label: "Max clip height",
        desc: "Caps downloaded stock clip resolution.",
        examples: "720 · 1080 · 2160",
      },
      {
        key: "STOCK_FOOTAGE_MIN_DURATION",
        label: "Min clip duration",
        desc: "Filters out clips shorter than this number of seconds.",
        examples: "4 default · 6 longer",
      },
      {
        key: "SCENE_PHOTO_RATIO",
        label: "Photo / video mix (%)",
        desc: "Percentage of scenes that use still photos with Ken Burns motion instead of moving video clips.",
        examples: "0 video only · 40 default · 50 batch",
      },
      {
        key: "SCENE_MIX_MODE",
        label: "Photo distribution",
        desc: "How photo scenes are distributed across the timeline.",
        examples: "random · alternating",
      },
      {
        key: "IMAGE_RATIO",
        label: "Output aspect ratio",
        desc: "Final video aspect ratio.",
        examples: "16:9 · 9:16 · 1:1",
      },
    ],
  },
  {
    title: "Video Assembly (FFmpeg)",
    subtitle: "Final stitching and rendering settings.",
    fields: [
      { key: "VIDEO_RESOLUTION", desc: "Final video resolution.", examples: "1920x1080 · 1280x720 · 3840x2160" },
      { key: "VIDEO_FPS", desc: "Frames per second.", examples: "24 · 30 · 60" },
      { key: "TRANSITION_MIN", label: "Transition min", desc: "Shortest transition duration.", examples: "0.3 default" },
      { key: "TRANSITION_MAX", label: "Transition max", desc: "Longest transition duration. Set 0 for hard cuts.", examples: "0.7 default · 0 hard cuts" },
      { key: "SCENE_TAIL_SILENCE", label: "Pause between scenes", desc: "Per-scene mode only. Adds silence to separately generated scene audio.", examples: "0.4 default" },
      { key: "SCENE_DURATION_SECONDS", desc: "Fallback clip duration when audio length is unknown.", examples: "5 default" },
    ],
  },
  {
    title: "On-Screen Text (hook emphasis)",
    subtitle: "Automatic captions for explicit numbers, years, money amounts, percentages, or measurements.",
    fields: [
      { key: "TEXT_OVERLAY_MODE", label: "When to show captions", desc: "hook shows captions only in the opening. all allows them anywhere. off disables them.", examples: "hook · all · off" },
      { key: "TEXT_OVERLAY_HOOK_SECONDS", label: "Hook length", desc: "When mode is hook, captions appear only within this many seconds from the start.", examples: "30 default" },
      { key: "TEXT_OVERLAY_FONT", label: "Caption font", desc: "Absolute path to a .ttf/.otf font. Leave empty for auto-detection.", examples: "empty = auto" },
      { key: "CAPTION_LEAD_IN_SEC", label: "Caption lead-in", desc: "How early captions may appear before the spoken word.", examples: "0 default · 0.1 max" },
      { key: "CAPTION_TRAIL_SEC", label: "Caption trail", desc: "How long captions remain after the spoken word.", examples: "0.35 default" },
      { key: "CAPTION_FONT_SIZE_PERCENT", label: "Caption font size (%)", desc: "Caption font size as a percent of video height.", examples: "13 default · 15 larger" },
      { key: "CAPTION_POSITION_Y_PERCENT", label: "Caption vertical position (%)", desc: "Vertical position as a percent of video height.", examples: "72 default" },
      { key: "CAPTION_DETECTION_MODE", label: "Caption detection mode", desc: "literal detects only explicit values. off disables auto captions.", examples: "literal · off" },
    ],
  },
  {
    title: "Step Overlays",
    subtitle: "Animated step title overlays such as STEP 1 / COLLECT & CHOP SCRAPS.",
    fields: [
      { key: "STEP_OVERLAY_TRAIL_SEC", label: "Step overlay trail", desc: "How long the step overlay remains after the spoken step title finishes.", examples: "1.0 default" },
      { key: "STEP_OVERLAY_ANIMATION", label: "Step overlay animation", desc: "Animation style for step overlay entrance/exit.", examples: "slide-up · fade · none" },
      { key: "STEP_OVERLAY_ENTER_SEC", label: "Entrance duration", desc: "Duration of the entrance animation.", examples: "0.35 default" },
      { key: "STEP_OVERLAY_EXIT_SEC", label: "Exit duration", desc: "Duration of the exit fade animation.", examples: "0.25 default" },
    ],
  },
  {
    title: "Performance (Concurrency)",
    subtitle: "Parallel job limits. Lower values are slower but gentler on API limits.",
    fields: [
      { key: "TTS_CONCURRENCY", desc: "Simultaneous TTS jobs.", examples: "3 default" },
      { key: "ANIMATION_CONCURRENCY", desc: "Simultaneous stock footage jobs.", examples: "5 default · 2 batch" },
      { key: "ASSEMBLE_CONCURRENCY", desc: "Simultaneous FFmpeg clip renders.", examples: "4 default" },
    ],
  },
  {
    title: "Reliability",
    subtitle: "Failure handling.",
    fields: [
      { key: "FAILURE_THRESHOLD_PERCENT", desc: "If more than this percent of scenes fail, the run aborts.", examples: "25 default" },
    ],
  },
];
