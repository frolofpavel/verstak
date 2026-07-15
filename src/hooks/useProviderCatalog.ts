import { useEffect, useState } from 'react'
import {
  mergeProviderCatalog,
  BUNDLED_PROVIDERS,
  type CatalogProvider,
  type CatalogSource,
} from '../lib/model-catalog'

// Срез 2.0.7-D: единый каталог провайдеров для Settings.
//
// Раньше Settings хардкодил массив PROVIDERS — второе зеркало реестра с собственной
// копией models[] (композер уже давно строит каталог из providers:list). Хук стирает
// это расхождение: и Settings, и композер теперь берут модели/транспорт из ОДНОГО
// источника — main-реестра через IPC.
//
// Дизайн «bundled-first»: стартуем СИНХРОННО с офлайн-снапшотом (каталог никогда не
// пуст — mount-эффекты Settings, читающие secretKey/models, работают сразу), затем
// заменяем на live из providers:list. Если IPC упал — остаёмся на bundled с честной
// меткой source='bundled' (карточка, шаг 6).

export interface ProviderCatalogState {
  providers: CatalogProvider[]
  /** live — из providers:list; bundled — офлайн-снапшот (IPC не ответил). */
  source: CatalogSource
  /** true пока не пришёл ответ live (показываем bundled). */
  loading: boolean
}

export function useProviderCatalog(): ProviderCatalogState {
  // Лениво — один раз собираем bundled, чтобы ссылка была стабильна между рендерами
  // до прихода live (иначе mount-эффекты, замкнувшие providers, дёргались бы зря).
  const [state, setState] = useState<ProviderCatalogState>(() => ({
    providers: mergeProviderCatalog(BUNDLED_PROVIDERS, { source: 'bundled' }),
    source: 'bundled',
    loading: true,
  }))

  useEffect(() => {
    let cancelled = false
    void window.api.providers
      .list()
      .then(dto => {
        if (cancelled) return
        // Пустой ответ рабочего IPC — аномалия; лучше остаться на bundled, чем показать пусто.
        if (!Array.isArray(dto) || dto.length === 0) {
          setState(s => ({ ...s, loading: false }))
          return
        }
        setState({ providers: mergeProviderCatalog(dto, { source: 'live' }), source: 'live', loading: false })
      })
      .catch(() => {
        if (cancelled) return
        // IPC упал — bundled с явной меткой (уже в state), просто снимаем loading.
        setState(s => ({ ...s, loading: false }))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
