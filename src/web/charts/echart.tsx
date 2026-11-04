import { BarChart, ScatterChart } from 'echarts/charts'
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useRef } from 'react'

import type { LeadBand } from '../../stats/types.ts'
import type { ChartTokens } from './options.ts'

// Tree-shaken: only the series and components these pages draw are registered.
use([BarChart, ScatterChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer])

export interface EChartProps {
  readonly option: EChartsCoreOption
  readonly ariaLabel: string
  readonly height?: number
}

/** One ECharts canvas, resized with its box and disposed with the component. */
export function EChart({ option, ariaLabel, height = 260 }: EChartProps) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<EChartsType | undefined>(undefined)

  useEffect(() => {
    if (!box.current) return
    const instance = init(box.current)
    chart.current = instance
    const observer = new ResizeObserver(() => instance.resize())
    observer.observe(box.current)
    return () => {
      observer.disconnect()
      instance.dispose()
      chart.current = undefined
    }
  }, [])

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={box} role="img" aria-label={ariaLabel} style={{ height, width: '100%' }} />
}

const BAND_VARIABLES: Readonly<Record<LeadBand, string>> = {
  apply: '--band-apply',
  ask: '--band-ask',
  skip: '--band-skip',
  unscored: '--band-unscored',
}

/** The page's colour tokens, read from its CSS variables so the charts follow light and dark mode. */
export function readTokens(element: Element = document.documentElement): ChartTokens {
  const style = getComputedStyle(element)
  const read = (name: string): string => style.getPropertyValue(name).trim()
  return {
    fg1: read('--fg1'),
    fg2: read('--fg2'),
    fg3: read('--fg3'),
    border: read('--border'),
    surface: read('--surface'),
    accent: read('--accent'),
    neutral: read('--chart-neutral'),
    bands: {
      apply: read(BAND_VARIABLES.apply),
      ask: read(BAND_VARIABLES.ask),
      skip: read(BAND_VARIABLES.skip),
      unscored: read(BAND_VARIABLES.unscored),
    },
  }
}
