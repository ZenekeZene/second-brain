#!/usr/bin/env python3
"""
Fetch YouTube transcript using youtube_transcript_api.
Usage: python3 yt-transcript.py <video_id>

Priority: English > any auto-generated > any manual.
Outputs plain text to stdout.
Requires: pip install youtube-transcript-api
"""
import sys, re

def main():
    if len(sys.argv) < 2:
        sys.stderr.write('Usage: yt-transcript.py <video_id>\n')
        sys.exit(1)

    video_id = sys.argv[1]

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        sys.stderr.write('youtube-transcript-api not installed. Run: pip install youtube-transcript-api\n')
        sys.exit(2)

    api = YouTubeTranscriptApi()

    try:
        tl = api.list(video_id)
    except Exception as e:
        sys.stderr.write(f'Could not list transcripts: {e}\n')
        sys.exit(1)

    transcript = None

    # 1. Try English auto-generated or manual
    try:
        transcript = tl.find_transcript(['en', 'en-US', 'en-GB', 'en-orig'])
    except Exception:
        pass

    # 2. Fall back to any auto-generated language
    if not transcript:
        gen = list(tl._generated_transcripts.values())
        if gen:
            transcript = gen[0]

    # 3. Fall back to any manually created transcript
    if not transcript:
        manual = list(tl._manually_created_transcripts.values())
        if manual:
            transcript = manual[0]

    if not transcript:
        sys.stderr.write('No transcripts available for this video.\n')
        sys.exit(1)

    lang = getattr(transcript, 'language_code', '?')
    sys.stderr.write(f'transcript-lang:{lang}\n')

    try:
        data = transcript.fetch()
        text = ' '.join(s.text for s in data)
        text = re.sub(r'\[.*?\]', '', text)   # strip [Music], [Aplausos], etc.
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            sys.stderr.write('Transcript is empty after parsing.\n')
            sys.exit(1)
        print(text)
    except Exception as e:
        sys.stderr.write(f'Error fetching transcript: {e}\n')
        sys.exit(1)

if __name__ == '__main__':
    main()
