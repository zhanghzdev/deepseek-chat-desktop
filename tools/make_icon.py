"""把单尺寸 ico 转成 Windows 需要的多尺寸 ico（16/24/32/48/64/128/256）。"""
import sys
from pathlib import Path

from PIL import Image

SIZES = [256, 128, 64, 48, 32, 24, 16]


def main(src: str, dst: str) -> None:
    image = Image.open(src)
    print(f"source: {image.size} {image.mode}")
    image = image.convert("RGBA")

    # 正方形画布，避免非等比缩放
    side = max(image.size)
    if image.size != (side, side):
        canvas = Image.new("RGBA", (side, side), (255, 255, 255, 0))
        canvas.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        image = canvas
        print(f"padded to square: {image.size}")

    # Pillow 只会缩小不会放大，源图不足 256 时补到 256，保证包含最大尺寸
    if image.width < 256:
        image = image.resize((256, 256), Image.LANCZOS)
        print(f"upscaled to: {image.size}")

    out = Path(dst)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"written: {out} ({out.stat().st_size} bytes)")

    # 校验结果
    check = Image.open(out)
    print(f"ico entries: {sorted(check.info.get('sizes', []))}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])