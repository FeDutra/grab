#!/bin/bash
mkdir -p src-tauri/resources
mkdir -p src-tauri/binaries
echo "Baixando modelo ggml-base.bin..."
curl -L -o src-tauri/resources/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
echo "Compilando whisper.cpp..."
git clone https://github.com/ggerganov/whisper.cpp.git /tmp/whisper_src
cd /tmp/whisper_src
make -j
cp build/bin/whisper-cli ../src-tauri/binaries/whisper-cli-x86_64-apple-darwin
cp build/bin/whisper-cli ../src-tauri/binaries/whisper-cli-aarch64-apple-darwin
echo "Concluido!"
