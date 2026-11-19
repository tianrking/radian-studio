#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo "Usage: $0 /path/to/ffmpeg-9.0.2" >&2; exit 2; fi
cd "$1"
./configure --disable-everything --disable-doc --disable-debug --disable-network \
  --disable-autodetect --disable-ffplay --disable-ffprobe --disable-avdevice \
  --enable-protocol=file,pipe --enable-demuxer=mpegts,mov --enable-muxer=mp4,mpegts \
  --enable-parser=h264 --enable-decoder=h264 \
  --enable-bsf=extract_extradata,h264_mp4toannexb,filter_units
make -j "${JOBS:-8}" ffmpeg
