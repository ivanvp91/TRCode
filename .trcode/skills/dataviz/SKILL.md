---
name: dataviz
description: Build a chart or data visualization that answers a question honestly — right chart type for the data, truthful axes, semantic color, direct labels, readable in light and dark. Use before drawing any chart, graph, plot, or histogram in any medium (SVG, canvas, plotting library).
description_ru: Построить график или визуализацию данных, честно отвечающую на вопрос — верный тип графика под данные, правдивые оси, семантический цвет, подписи у самих данных, читаемость в светлой и тёмной теме. Использовать до отрисовки любого графика, диаграммы, гистограммы в любой среде (SVG, canvas, библиотеки).
triggers: график, графики, диаграмма, диаграмму, chart, plot, визуализация, visualization, визуализируй, гистограмма, histogram, heatmap, тепловая карта, scatter, спарклайн, sparkline, pie chart, круговая диаграмма, bar chart, line chart, ось, axes, легенда графика
---

# Data visualization

## 1. The question picks the chart
Name the question the chart answers before drawing; the form follows:
- Change over time → line (continuous) or bars (discrete periods). One metric = one line; more than 4–5 lines = split into small multiples.
- Comparison across categories → horizontal bars sorted by value (not alphabet), one bar per category.
- Part of a whole → stacked bar or, only with ≤ 4 parts, a pie; beyond that, bars.
- Relationship of two variables → scatter; add a trend line only if the claim is about the trend.
- Distribution → histogram or box plot.
- Density over two dimensions (time × category) → heatmap with a documented scale.
If no single question exists yet — that's a table, not a chart.

## 2. Honest axes or nothing
- Bar charts start at zero, always — a truncated bar axis is a lie about proportions.
- Line charts may zoom the range, but say so (visible axis labels, no hidden clipping).
- One y-axis per chart by default; dual axes only when units differ AND both series are named at their axis; never to fake correlation.
- Time axes evenly spaced; missing periods shown as gaps, not silently skipped.
- Axis labels with units (%, $, ms); ticks in round numbers, thinned to ~4–6.

## 3. Color carries meaning or stays neutral
- One neutral for context, one accent for "the series that answers the question". Semantic pairs stay reserved: green/red = positive/negative only.
- Categorical series: distinct hues up to ~6, then group the tail into "other".
- Sequential data → one hue, varying lightness; diverging data (around zero) → two hues through a neutral midpoint.
- Never encode meaning in color alone — pair with position, label, or pattern; check the chart still reads in grayscale.

## 4. Labels beat legends
Direct-label lines at their right edge and bars at their tip when there's room; a legend is the fallback, not the default. Title states the finding ("Расходы выросли в марте на 40%"), not the metadata ("График расходов"). Numbers on the chart formatted short (12.4k, not 12400.00). Tooltips for precision, labels for the story.

## 5. Execution
- Default medium: inline SVG (crisp, styleable, no dependencies); canvas for >1000 points or live updates; a library only if the project already uses one — match it.
- Colors and fonts from the surrounding product's tokens; the chart must survive both light and dark themes (no hardcoded black text or white grid).
- Grid lines lighter than data, axes lighter than grid; the ink hierarchy is data > labels > axes > grid.
- Responsive: the chart scales to container width; wide charts scroll inside their own container, labels never overlap (rotate/thin ticks instead).

## What not to do
- No 3D, no decorative gradients on data marks, no shadows on bars — chartjunk hides the data.
- No pie charts for comparisons or for more than 4 slices.
- No rainbow palettes on sequential data.
- No inventing data points: if data is missing, show the gap and say so.
- No chart when a single number with context tells the story better.

## Answer format
The chart (code), plus three lines: the question it answers, why this chart type, and what the axes/colors encode. If the data has caveats (gaps, small sample, mixed units) — name them next to the chart, not in fine print.
