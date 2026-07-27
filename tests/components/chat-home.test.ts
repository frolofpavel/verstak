// @vitest-environment jsdom
//
// Домашний экран — одна понятная точка входа в задачу.
// Каталог ролей и боковая карточка не должны вернуться незаметно.
import { describe, it, expect, afterEach } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { ChatHome } from '../../src/components/ChatHome'

afterEach(() => cleanup())

describe('ChatHome', () => {
  it('показывает только центральный вопрос без каталога и кнопок', () => {
    render(createElement(ChatHome, { title: 'Что нужно сделать?' }))

    expect(screen.getByRole('heading', { name: 'Что нужно сделать?' })).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Agent/i)).toBeNull()
  })
})
