import { describe, expect, it } from 'vitest'
import { en } from '../../../src/i18n/en'
import { ru } from '../../../src/i18n/ru'

describe('Computer Use privacy disclosure', () => {
  it.each([
    {
      locale: 'en',
      text: en.settings.computerUse.dataScope,
      modelDisclosure: 'sent to the selected AI model after recognizable secrets are redacted locally',
      screenshotDisclosure: 'R2 may also send a bounded capture of the exact selected window',
      technicalBoundary: 'does not copy observation or window contents, or text typed into the target, into technical telemetry, checkpoints, the agent-run journal, or memory',
      generalPolicy: "Ordinary visible chat and selected-model data handling remain governed by the app's general data policy",
      staleClaim: 'model response may be saved in chat history and the checkpoint',
    },
    {
      locale: 'ru',
      text: ru.settings.computerUse.dataScope,
      modelDisclosure: 'передаются выбранной AI-модели после локального удаления распознаваемых секретов',
      screenshotDisclosure: 'R2 также может передать ограниченный снимок только точно выбранного окна',
      technicalBoundary: 'не копирует содержимое наблюдений и окна или вводимый в цель текст в техническую телеметрию, checkpoints, журнал agent-run и память',
      generalPolicy: 'Обычная видимая переписка и обмен с выбранной моделью подчиняются общей политике данных приложения',
      staleClaim: 'ответ модели могут сохраниться в истории чата и checkpoint',
    },
  ])('truthfully separates model disclosure, R2 screenshots, technical sinks, and ordinary chat in $locale', ({
    text,
    modelDisclosure,
    screenshotDisclosure,
    technicalBoundary,
    generalPolicy,
    staleClaim,
  }) => {
    expect(text).toContain(modelDisclosure)
    expect(text).toContain(screenshotDisclosure)
    expect(text).toContain(technicalBoundary)
    expect(text).toContain(generalPolicy)
    expect(text).not.toContain(staleClaim)
  })
})
