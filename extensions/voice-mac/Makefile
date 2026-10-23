SWIFTC = swiftc
FLAGS = -O -framework AppKit -framework SwiftUI -framework AVFoundation -framework AudioToolbox
SOURCES = src/AudioRecorder.swift \
          src/HotkeyListener.swift \
          src/DaemonClient.swift \
          src/KokoroClient.swift \
          src/Transcriber.swift \
          src/HistoryModel.swift \
          src/HistoryPanel.swift \
          src/NotchHUD.swift \
          src/FloatingHUD.swift \
          src/VoiceApp.swift \
          src/main.swift
TARGET = bin/minclaw-voice

all: $(TARGET)

$(TARGET): $(SOURCES)
	@mkdir -p bin
	$(SWIFTC) $(FLAGS) $(SOURCES) -o $(TARGET)
	@echo "✅ Built $(TARGET) successfully"

clean:
	rm -f $(TARGET)
