# -*- coding: utf-8 -*-
"""把生成的主 logo 缩放为 fnOS 一键超频所需的各尺寸图标。居中裁剪为正方形。"""
from PIL import Image
import os

SRC = r'C:\Users\Administrator\Documents\treawork测试文件夹\one_oc_build\assets\oc_logo_master.jpg'
ROOT = r'C:\Users\Administrator\Documents\treawork测试文件夹\one_oc_build\onekey-overclock'

im = Image.open(SRC).convert('RGB')
w, h = im.size
# 居中正方形裁剪
s = min(w, h)
left = (w - s) // 2; top = (h - s) // 2
im = im.crop((left, top, left + s, top + s))
# 内缩 7% 裁掉四角(右下角含 "AI生成" 水印),保留居中徽章
ins = int(s * 0.07)
im = im.crop((ins, ins, s - ins, s - ins))

def save(path, size):
    im.resize((size, size), Image.LANCZOS).save(path, 'PNG')
    print('PNG', size, '->', path, os.path.getsize(path), 'bytes')

save(os.path.join(ROOT, 'ICON.PNG'), 64)
save(os.path.join(ROOT, 'ICON_256.PNG'), 256)
save(os.path.join(ROOT, 'app', 'ui', 'images', 'icon.png'), 64)
save(os.path.join(ROOT, 'app', 'ui', 'images', 'icon_64.png'), 64)
save(os.path.join(ROOT, 'app', 'ui', 'images', 'icon_256.png'), 256)
print('done')