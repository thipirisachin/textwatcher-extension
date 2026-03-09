# TextWatcher Extension — Icon Generator
# Run this script once to generate PNG icons from SVG using Node.js (sharp) or Python (Pillow)
# Or use the inline base64 PNGs below

import base64
import struct
import zlib

def create_png(size, color_hex='6366f1', letter='T'):
    """
    Creates a minimal valid PNG icon programmatically.
    No dependencies required.
    """
    # Parse hex color
    r = int(color_hex[0:2], 16)
    g = int(color_hex[2:4], 16)
    b = int(color_hex[4:6], 16)

    # Create pixel data — solid color square with rounded feel
    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            # Simple circle mask for rounded icon look
            cx, cy = size / 2, size / 2
            radius = size / 2 - 1
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if dist <= radius:
                row.extend([r, g, b, 255])  # RGBA accent color
            else:
                row.extend([0, 0, 0, 0])    # Transparent outside
        pixels.append(bytes(row))

    # Build PNG
    def png_chunk(chunk_type, data):
        c = chunk_type + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    ihdr = png_chunk(b'IHDR', ihdr_data)

    # IDAT (image data)
    raw = b''
    for row in pixels:
        raw += b'\x00' + row  # filter byte
    compressed = zlib.compress(raw, 9)
    idat = png_chunk(b'IDAT', compressed)

    # IEND
    iend = png_chunk(b'IEND', b'')

    return sig + ihdr + idat + iend


if __name__ == '__main__':
    import os
    icons_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in [16, 48, 128]:
        png_data = create_png(size)
        out_path = os.path.join(icons_dir, f'icon{size}.png')
        with open(out_path, 'wb') as f:
            f.write(png_data)
        print(f'Created {out_path} ({size}x{size})')

    print('Icons generated successfully!')
