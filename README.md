# ZaloLinux

Chạy Zalo PC **native trên Linux**, không cần Wine, kể cả gọi thoại, gọi video và chia sẻ màn hình.

Bản Windows của Zalo PC là một ứng dụng Electron. Phần chat chạy được trên Linux sau vài bản vá nhỏ. Phần gọi điện thì nằm trong `ZaloCall.exe`, một tiến trình Qt/WebRTC độc quyền. Dự án này viết lại engine gọi đó bằng JavaScript (Electron + WebCodecs), dựa trên giao thức đã dịch ngược.

> Repo **không chứa mã hay file nào của Zalo**. Bạn tự lấy bộ cài Windows chính thức, các script ở đây sẽ giải nén và vá nó trên máy bạn.

## Trạng thái

Đã thử với Zalo PC 26.10.10 trên Arch Linux (Hyprland, Wayland):

| Tính năng | Trạng thái |
|---|---|
| Đăng nhập QR, chat, đồng bộ tin nhắn, file | ✅ |
| Cơ sở dữ liệu mã hoá (SQLCipher) như bản gốc | ✅ |
| Gọi thoại đến / đi, từ chối, máy bận | ✅ |
| Gọi video hai chiều (H.264) | ✅ |
| Chia sẻ màn hình trong cuộc gọi video (PipeWire) | ✅ |
| Tin nhắn cuộc gọi trong khung chat | ✅ |
| Gọi nhóm | ❌ |

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `tools/patch.py` | Tạo `app/` từ `app.asar` gốc: mọi chỉnh sửa vào file của Zalo đều nằm ở đây |
| `shims/zcall-linux/` | Engine gọi thay `ZaloCall.exe`: relay UDP, SRTP, RTP/Opus/H.264, cửa sổ cuộc gọi |
| `shims/nativelibs/` | Thay các module native Windows (sqlite3 dựng lại với SQLCipher, …) |
| `tools/install.sh` | Cài cho người dùng hiện tại vào `~/.local` |
| `tests/` | Test end-to-end cho engine (relay, Zalo và đối phương đều là giả) |
| `re/NOTES.md` | Ghi chép dịch ngược: IPC, tín hiệu, giao thức relay, SRTP, video |

## Build và cài đặt

Cần: `python3`, `7z`, `npx`, `g++`, `sqlcipher` (`sudo pacman -S sqlcipher p7zip nodejs npm`).

```sh
# 1. Bộ cài Windows chính thức (bản đã thử: 26.10.10), đặt ở thư mục gốc repo
7z x zalosetup-26-10-10.exe -oextract/installer
7z x 'extract/installer/$PLUGINSDIR/app-32.7z' -oextract/app
npx @electron/asar extract extract/app/Zalo-*/resources/app.asar extract/asar

# 2. Electron 22.3.27 linux-x64 (cùng dòng 22.x với bản Windows)
mkdir -p runtime/electron
curl -L https://github.com/electron/electron/releases/download/v22.3.27/electron-v22.3.27-linux-x64.zip -o /tmp/electron.zip
unzip /tmp/electron.zip -d runtime/electron

# 3. node-sqlite3 5.0.2 + node-addon-api 3.2.1 (đúng bản Zalo dùng), dựng với SQLCipher
mkdir -p vendor
curl -L https://github.com/TryGhost/node-sqlite3/archive/refs/tags/v5.0.2.tar.gz | tar xz -C vendor
curl -L https://github.com/nodejs/node-addon-api/archive/refs/tags/3.2.1.tar.gz | tar xz -C vendor
tools/build-sqlite3.sh

# 4. Vá và cài
python3 tools/patch.py extract/asar app
tools/install.sh            # gỡ: tools/install.sh --uninstall
```

Sau đó mở **Zalo** từ menu ứng dụng hoặc chạy `zalo`. Dữ liệu nằm ở `~/.config/ZaloData`, giống bản gốc.

Chạy thử không cần cài: `tools/run.sh 0`. Thêm `ZALO_DEBUG_PORT=9222` để mở DevTools protocol.

## Test

```sh
ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/engine-e2e.js    # gọi đến
ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/outgoing-e2e.js  # gọi đi
ELECTRON_RUN_AS_NODE=1 runtime/electron/electron tests/video-e2e.js     # video + chia sẻ màn hình
```

## Lưu ý

- Đây là dự án cá nhân, không liên quan tới VNG/Zalo. Giao thức có thể thay đổi theo phiên bản Zalo.
- Server Zalo phân quyền tính năng theo loại client; bản vá khai báo client Linux là macOS (23) để được đồng bộ tin nhắn.
