#!/usr/bin/env python3
"""
生成符合 macOS 标准与透明背景的 App 图标脚本
功能：
1. 从源图片中提取圆角矩形主体（Squircle）
2. 消除背景，制作符合 Apple macOS 规范的抗锯齿透明通道（Alpha Mask）
3. 添加原生 macOS 风格的柔和投影
4. 输出透明底 1024x1024 PNG 至 public/logo.png
"""

import sys
import os
from PIL import Image, ImageDraw, ImageFilter

def process_icon(src_path, output_path, mode='macos'):
    if not os.path.exists(src_path):
        print(f"错误: 找不到源文件 {src_path}")
        sys.exit(1)
        
    src = Image.open(src_path).convert('RGBA')
    w, h = src.size
    
    # 裁剪中心图标区域（去除 AI 生成时的白底外框）
    crop_box = (175, 175, 849, 849) if (w == 1024 and h == 1024) else (0, 0, w, h)
    art = src.crop(crop_box).resize((2048, 2048), Image.Resampling.LANCZOS)
    
    canvas_size = 1024
    
    if mode == 'macos':
        # 苹果 macOS 官方设计规范：1024 画布内 824 居中圆角主体 + 真实阴影 + 完全透明背景
        icon_size = 824
        radius = 185
        super_size = icon_size * 2
        super_radius = radius * 2
        
        art_scaled = art.resize((super_size, super_size), Image.Resampling.LANCZOS)
        mask_super = Image.new('L', (super_size, super_size), 0)
        draw_super = ImageDraw.Draw(mask_super)
        draw_super.rounded_rectangle([0, 0, super_size - 1, super_size - 1], radius=super_radius, fill=255)
        
        icon_masked = Image.new('RGBA', (super_size, super_size), (0, 0, 0, 0))
        icon_masked.paste(art_scaled, (0, 0), mask=mask_super)
        icon_final = icon_masked.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
        
        # 柔和阴影层
        shadow_mask = Image.new('L', (canvas_size, canvas_size), 0)
        shadow_draw = ImageDraw.Draw(shadow_mask)
        offset_x = (canvas_size - icon_size) // 2
        offset_y = (canvas_size - icon_size) // 2 + 12
        shadow_draw.rounded_rectangle([offset_x, offset_y, offset_x + icon_size - 1, offset_y + icon_size - 1], radius=radius, fill=110)
        shadow_blurred = shadow_mask.filter(ImageFilter.GaussianBlur(radius=28))
        
        canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
        shadow_img = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 255))
        canvas.paste(shadow_img, (0, 0), mask=shadow_blurred)
        
        icon_x = (canvas_size - icon_size) // 2
        icon_y = (canvas_size - icon_size) // 2
        canvas.paste(icon_final, (icon_x, icon_y), mask=icon_final)
    else:
        # 铺满版本：1024x1024 边缘透明圆角
        radius = int(1024 * 0.224)
        super_size = 2048
        mask_super = Image.new('L', (super_size, super_size), 0)
        draw_super = ImageDraw.Draw(mask_super)
        draw_super.rounded_rectangle([0, 0, super_size - 1, super_size - 1], radius=radius * 2, fill=255)
        
        icon_super = Image.new('RGBA', (super_size, super_size), (0, 0, 0, 0))
        icon_super.paste(art, (0, 0), mask=mask_super)
        canvas = icon_super.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)

    canvas.save(output_path, 'PNG')
    print(f"成功保存透明图标至: {output_path}")

if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'public/logo.png'
    out = sys.argv[2] if len(sys.argv) > 2 else 'public/logo.png'
    mode = sys.argv[3] if len(sys.argv) > 3 else 'macos'
    process_icon(src, out, mode)
