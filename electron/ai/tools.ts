import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { join, relative } from 'path'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import type { ToolDefinition } from './types'
import { classifyCommand } from './command-policy'
import { isForbiddenPath, scanText } from './secret-scanner'
import { getProjectMap, invalidateProjectMap, markFileDirty, projectMapToText, getDependencyMap, invalidateDependencyMap } from './project-map'
import { safeRealJoin } from './path-policy'
import { treeKill } from './child-kill'
import { isDangerousCommand } from '../connectors/ssh'
import { shq } from '../projects/ssh-fs'
import { parseSshProjectPath, makeSshExec, createSshBackend, type SshBackend } from '../projects/ssh-backend'

const execFileAsync = promisify(execFile)

const MAX_READ_BYTES = 2 * 1024 * 1024  // 2 MB
const MAX_SEARCH_HITS = 80
const MAX_LINE_CHARS = 220
const IGNORE_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.vite', '.verstak-data', '.superpowers', '__pycache__', 'venv', '.venv', 'target', 'build'])

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Прочитать содержимое файла относительно корня проекта',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь от корня проекта' } },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: 'Перечислить файлы и папки в директории',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь, "." для корня' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Записать ПОЛНОЕ содержимое файла. Используй ТОЛЬКО для СОЗДАНИЯ новых файлов или ПОЛНОЙ замены маленьких файлов (<200 строк). Для ПРАВКИ существующих больших файлов вместо этого вызывай apply_patch — это дешевле и безопаснее.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'apply_patch',
    description: `Точечная правка файла через SEARCH/REPLACE блоки. Намного дешевле и безопаснее чем write_file для существующих файлов.

Формат diff:
<<<<<<< SEARCH
точный кусок текущего содержимого (включая отступы)
=======
новый текст
>>>>>>> REPLACE

Несколько блоков в одном файле — разделяй пустой строкой. Каждый SEARCH должен УНИКАЛЬНО совпадать с содержимым файла; если фрагмент встречается несколько раз — добавь больше контекста. Файл должен существовать (для создания используй write_file).

Возвращает количество применённых блоков. Требует подтверждения пользователя как обычный write — diff отображается в том же модальном окне.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь к существующему файлу.' },
        diff: { type: 'string', description: 'Один или несколько SEARCH/REPLACE блоков.' },
        anchor_hash: { type: 'string', description: 'SHA-256 первых 8 символов от строки-якоря. Если указан, патч применяется только если хэш строки совпадает — защита от промаха по позиции. Опционально.' }
      },
      required: ['path', 'diff']
    }
  },
  {
    name: 'run_command',
    description: 'Запустить shell-команду в корне проекта. Команда требует подтверждения пользователя. Возвращает stdout/stderr/exitCode.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Команда для shell. Без побочных эффектов вне проекта.' } },
      required: ['command']
    }
  },
  {
    name: 'search_project',
    description: 'Полнотекстовый поиск по проекту (ripgrep). Возвращает совпадения в формате file:line:text. Игнорирует node_modules / .git / out / dist. Используй для нахождения определений функций, использований переменных, текстовых фрагментов.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Текст или regex для поиска.' },
        glob: { type: 'string', description: 'Опциональный glob-фильтр путей, например "**/*.ts" или "src/**".' },
        ignoreCase: { type: 'boolean', description: 'Игнорировать регистр (default true).' },
        regex: { type: 'boolean', description: 'Интерпретировать query как regex (default false, тогда литеральный поиск).' }
      },
      required: ['query']
    }
  },
  {
    name: 'find_files',
    description: 'Найти файлы в проекте по glob-паттерну. Возвращает относительные пути. Используй до read_file, когда не знаешь точное имя.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob, например "**/*.test.ts" или "src/**/Chat.tsx".' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'get_project_map',
    description: 'Получить структуру проекта одной командой: дерево директорий + top-level символы (functions, classes, components, types, exports) для каждого *.ts/*.tsx/*.js/*.jsx файла + количество строк. Используй ВПЕРВЫЕ при незнакомом проекте — экономит десятки read_file/list_directory вызовов. Карта кэшируется; для обновления вызови refresh_project_map.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: '"text" (default, компактный markdown) или "json" (структура).' }
      }
    }
  },
  {
    name: 'refresh_project_map',
    description: 'Принудительно пересканировать проект и обновить project map. Вызывай после крупных изменений структуры (новые файлы, переименования). Возвращает свежую карту.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', description: '"text" или "json".' }
      }
    }
  },
  {
    name: 'propose_edits',
    description: 'Атомарно предложить пакет изменений нескольких файлов сразу. Пользователь увидит все диффы в одной модалке с вкладками и сможет принять все одной кнопкой. Используй для рефакторингов, переименований, синхронных правок в нескольких местах — вместо последовательной серии write_file. Каждый элемент edits — это {path, content, reason}: reason кратко объясняет зачем эта правка.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          description: 'Список правок (1..20).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Относительный путь от корня проекта.' },
              content: { type: 'string', description: 'Полное новое содержимое файла.' },
              reason: { type: 'string', description: 'Краткое обоснование правки (1 строка).' }
            },
            required: ['path', 'content']
          }
        },
        summary: { type: 'string', description: 'Общий заголовок пакета правок, 1 строка.' }
      },
      required: ['edits']
    }
  },
  {
    name: 'list_connectors',
    description: 'Перечислить внешние коннекторы (1С OData и т.п.) — что подключено, готово ли к работе. Возвращает массив { id, label, kind, status, detail }.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'connector_query',
    description: 'Выполнить запрос к внешнему коннектору. Для 1С (id="onec") — entity + filter/select/top или metadata:true. Для HTTP (id="http") — endpoint + method + path + query/body/headers. Креды и base URL берутся из настроек — НЕ передавай пароли в args.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID коннектора: "onec" | "http".' },
        // 1С OData params
        entity: { type: 'string', description: '[onec] Имя OData-сущности, например "Catalog_Контрагенты".' },
        filter: { type: 'string', description: '[onec] OData $filter.' },
        select: { type: 'string', description: '[onec] Список полей через запятую.' },
        top: { type: 'number', description: '[onec] Размер страницы 1..100.' },
        metadata: { type: 'boolean', description: '[onec] Если true — вернёт $metadata.' },
        // HTTP params
        endpoint: { type: 'string', description: '[http] Имя сконфигурированного эндпоинта.' },
        method: { type: 'string', description: '[http] GET/POST/PUT/DELETE/PATCH (default GET).' },
        path: { type: 'string', description: '[http] Относительный путь от base URL.' },
        query: { type: 'object', description: '[http] Query-параметры (плоский объект).' },
        body: { description: '[http] JSON-сериализуемое тело запроса.' },
        headers: { type: 'object', description: '[http] Дополнительные заголовки.' }
      },
      required: ['id']
    }
  },
  {
    name: 'read_journal',
    description: 'Прочитать последние записи журнала разработки проекта (что было сделано, какие команды запускались, какие файлы менялись, какие AI-сессии состоялись). Используй когда пользователь спрашивает «что недавно делали», «что улучшить», «какие были баги», или когда нужен self-reflection AI на собственную историю работы в этом проекте. Возвращает массив записей в обратном хронологическом порядке.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Сколько последних записей вернуть (default 30, max 100).' },
        kind: { type: 'string', description: 'Фильтр по типу: "session" (сводки AI-сессий), "tool" (вызовы инструментов), "note" (AI-ошибки/планы), "manual" (ручные заметки). Без фильтра — все типы.' }
      }
    }
  },
  {
    name: 'browser_navigate',
    description: 'Открыть URL во встроенном браузере Verstak (вкладка Browser). Возвращает финальный URL после редиректов. Если пользователь не открыл вкладку Browser, инструмент вернёт ошибку — попроси открыть вкладку.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL или поисковый запрос. Без схемы — будет добавлено https://.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_screenshot',
    description: 'Сделать скриншот текущей страницы во встроенном браузере. Скриншот будет автоматически прикреплён к следующему сообщению как изображение — провайдеры с vision (Gemini 3.5, GPT-4o) увидят его и смогут проанализировать визуально. Используй для отладки UI / визуальных регрессий.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_read_page',
    description: 'Получить текстовое содержимое текущей страницы во встроенном браузере (innerText, до 50 000 символов). Опционально передай CSS-селектор чтобы достать только нужный кусок.',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'Опциональный CSS-селектор, например "main article" или "#content".' } }
    }
  },
  {
    name: 'create_plan',
    description: 'Создать структурированный план многошаговой задачи. Используй когда задача требует 3+ шагов или явного согласования с пользователем. План отобразится во вкладке Plan; пользователь сможет выполнять шаги по одному.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Краткое название плана.' },
        steps: {
          type: 'array',
          description: 'Упорядоченный список шагов плана.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Конкретное действие (одна забота на шаг).' },
              detail: { type: 'string', description: 'ТЗ шага — его исполнит отдельный LLM-агент (возможно дешёвая модель), пиши для агента, не для человека: точные файлы/пути, что именно сделать (функции/эндпоинты/поля), критерий готовности («сделано» = как проверить). 3–10 конкретных строк, без общих фраз «улучшить»/«оптимизировать».' }
            },
            required: ['title']
          }
        }
      },
      required: ['title', 'steps']
    }
  },
  {
    name: 'preflight',
    description: 'Объяви план ПЕРЕД началом сложной, многофайловой или деструктивной задачи. Ничего не меняет — только показывает пользователю карточку «что я собираюсь сделать»: затронутые зоны, уровень риска, что проверить после, что вне scope / запрещено. Вызывай ДО первой правки/команды на такой задаче. Для тривиальных одиночных правок не нужен.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Одна-две строки: что собираюсь сделать и зачем.' },
        affectedZones: { type: 'array', items: { type: 'string' }, description: 'Файлы / папки / подсистемы, которые будут затронуты.' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Уровень риска изменения.' },
        riskReason: { type: 'string', description: 'Почему именно такой риск (1 строка).' },
        verifyAfter: { type: 'array', items: { type: 'string' }, description: 'Чем проверить результат после: команды, тесты, ручные шаги.' },
        outOfScope: { type: 'array', items: { type: 'string' }, description: 'Что НЕ трогаю / запреты / границы scope.' }
      },
      required: ['summary', 'risk']
    }
  },
  {
    name: 'render_chart',
    description: 'Сгенерировать SVG-диаграмму (bar / line / pie) для встройки в HTML/DOCX артефакт. Сохраняется в .verstak/artifacts/{date}/. Возвращает путь — далее его можно вставить как <img src> в HTML или использовать в DOCX. Идеально для аудитов Я.Директ, отчётов по конверсиям, разбивке источников.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Имя файла без расширения' },
        kind: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Тип диаграммы' },
        title: { type: 'string', description: 'Заголовок над графиком' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Подписи оси X / сегментов pie' },
        values: { type: 'array', items: { type: 'number' }, description: 'Числовые значения, длина = labels.length' },
        x_axis_label: { type: 'string', description: 'Подпись оси X (для bar/line)' },
        y_axis_label: { type: 'string', description: 'Подпись оси Y (для bar/line)' }
      },
      required: ['filename', 'kind', 'labels', 'values']
    }
  },
  {
    name: 'delegate_task',
    description: 'Делегировать узкую подзадачу другому AI-агенту (другая модель / скилл / роль). Используй когда: (а) нужна вторая независимая точка зрения на патч/решение; (б) подзадача узкая и можно отдать дешёвой модели; (в) нужно вытащить контекст из источника с другим скиллом. Sub-agent теперь РАБОТАЕТ С ИНСТРУМЕНТАМИ (agent-loop): он может читать файлы, искать по проекту, а с ролью executor/verifier — править файлы и запускать проверки. Набор tools ограничен ролью (см. role). Результат подтягивается обратно как tool_result. Sub-agent (роли executor/researcher/planner) МОЖЕТ делегировать дальше — но строго под лимитом глубины (до 2 уровней под главным) и общего числа агентов за прогон. На предельной глубине delegate_* субу недоступен.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: {
          type: 'string',
          description: 'ID скилла для sub-agent (например "code-review", "git-summary"). Если skill_id неизвестен — используется generic prompt.'
        },
        provider_id: {
          type: 'string',
          description: 'Опционально — провайдер для sub-agent (gemini-api / claude / openai / grok). Если не указан — берётся из default_provider скилла, иначе используется провайдер текущего чата.'
        },
        model: {
          type: 'string',
          description: 'Опционально — модель в рамках provider_id.'
        },
        role: {
          type: 'string',
          enum: ['planner', 'critic', 'executor', 'verifier', 'researcher'],
          description: 'Опционально — роль субагента. Определяет поведение И набор инструментов: researcher/critic/planner — read-only; verifier — read + проверки (test/typecheck/lint); executor — read + правки файлов + команды. Без роли — безопасный read-only набор.'
        },
        prompt: {
          type: 'string',
          description: 'Что именно нужно от sub-agent. Конкретный запрос с контекстом.'
        },
        group: {
          type: 'string',
          description: 'Опционально — тег/группа для массовой отмены субагентов через панель Agents.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'delegate_parallel',
    description: 'Запускает несколько подзадач параллельно. Каждая задача — независимый sub-agent С ИНСТРУМЕНТАМИ (agent-loop): он сам читает файлы / ищет по проекту, а с ролью executor/verifier правит код и запускает проверки. Provider задаётся НА КАЖДУЮ задачу — в одном батче можно СМЕШИВАТЬ разные провайдеры (например API и CLI). Поддерживает роли (planner/critic/executor/verifier/researcher) — роль определяет и поведение, и whitelist инструментов. Субагенты (executor/researcher/planner) могут делегировать дальше под лимитом глубины и числа агентов. Используй для параллельного анализа, кросс-верификации, исследования нескольких зон. До 10-12 задач с контролем concurrency.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Уникальный ID задачи для идентификации в результатах' },
              prompt: { type: 'string', description: 'Текст задачи для субагента' },
              provider_id: { type: 'string', description: 'Провайдер для ЭТОЙ задачи (опц. — по умолчанию текущий). Разные провайдеры (например API и CLI) можно смешивать в одном батче.' },
              model: { type: 'string', description: 'Модель (опц.)' },
              role: {
                type: 'string',
                enum: ['planner', 'critic', 'executor', 'verifier', 'researcher'],
                description: 'Роль субагента — определяет его поведение и фокус (опц.)'
              }
            },
            required: ['id', 'prompt']
          },
          description: 'Массив подзадач (рекомендуется 2-8, до 50 — они держатся в глобальной очереди и стримятся по несколько разом)'
        },
        group: {
          type: 'string',
          description: 'Опционально — тег/группа батча для массовой отмены через панель Agents. Если не задан — группой служит сам вызов.'
        },
        cost_cap_usd: {
          type: 'number',
          description: 'Опционально — лимит стоимости $ на ВЕСЬ этот батч (помимо cap сессии). При превышении оставшиеся задачи не выполняются. По умолчанию $3.'
        }
      },
      required: ['tasks']
    }
  },
  {
    name: 'todo_create',
    description: 'TodoGate: создать оркестрационный todo-лист разом (batch). Главный агент декомпозирует цель в список пунктов — суб-агенты потом берут (todo_update status=in_progress), закрывают (done) или блокируют (blocked). Лист виден пользователю в панели Агенты как живой прогресс. Используй в начале сложной многошаговой задачи перед делегированием.',
    parameters: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'Список названий пунктов (по одному действию на пункт).' },
        goal: { type: 'string', description: 'Опционально — общая цель листа (для группировки/контекста).' }
      },
      required: ['items']
    }
  },
  {
    name: 'todo_update',
    description: 'TodoGate: обновить статус пункта todo-листа. Суб-агент помечает пункт in_progress когда берёт его, done когда закрыл, blocked если застрял. Пункт идентифицируется по id (число) ИЛИ title (точное название).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID пункта (из todo_create / todo_list).' },
        title: { type: 'string', description: 'Точное название пункта (альтернатива id).' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'Новый статус.' },
        assignee_call_id: { type: 'string', description: 'Опционально — кто взял пункт (идентификатор суба).' }
      },
      required: []
    }
  },
  {
    name: 'todo_list',
    description: 'TodoGate: показать текущее состояние todo-листа сессии (прогресс + статусы пунктов). Read-only.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'orchestrate',
    description: 'Smart-оркестратор (главный агент): принимает большую цель → САМ декомпозирует её на подзадачи с ролями через вызов планировщика → создаёт todo-лист → запускает все подзадачи параллельно (sub-queue, семафор, cost-cap). Модель КАЖДОЙ подзадачи выбирается умно (smart-router по сложности: простая → дешёвая модель, сложная → дорогая). Используй для крупной задачи которую стоит распараллелить между ролями (researcher/executor/verifier/...). НЕ вызывается суб-агентами — только главный агент.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Большая цель в свободной форме — оркестратор сам разобьёт её на подзадачи с ролями.' },
        max_subtasks: { type: 'number', description: 'Опционально — максимум подзадач в декомпозиции (по умолчанию 5, потолок 12).' },
        cost_cap_usd: { type: 'number', description: 'Опционально — лимит $ на весь прогон оркестратора (по умолчанию $3).' }
      },
      required: ['goal']
    }
  },
  {
    name: 'swarm',
    description: 'Agent Swarm (рой агентов с консенсусом, только главный агент). Принимает ОДНУ большую цель → запускает РОЙ агентов, атакующих её ПАРАЛЛЕЛЬНО с разных углов/стратегий (несколько researcher с разными фокусами + independent executor-варианты + critic). Все работают над одной целью независимо. Затем агент-АРБИТР собирает все варианты, оценивает их и СИНТЕЗИРУЕТ консенсусный лучший результат — его и возвращает. Используй когда задача сложная/неоднозначная и ценны несколько независимых попыток + выбор лучшего (а не декомпозиция на подзадачи — для декомпозиции бери orchestrate). Уважает очередь, семафор, cost-cap и лимиты глубины/количества агентов. НЕ вызывается суб-агентами.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Одна большая цель, над которой работает весь рой.' },
        size: { type: 'number', description: 'Опционально — сколько агентов в рое (по умолчанию 4, потолок 8). Арбитр идёт сверх этого числа.' },
        strategy: { type: 'string', description: 'Опционально — подсказка стратегии роя (например "сделай упор на безопасность и edge cases"). Раздаётся агентам как доп. контекст.' },
        cost_cap_usd: { type: 'number', description: 'Опционально — лимит $ на весь рой включая арбитра (по умолчанию $3).' }
      },
      required: ['goal']
    }
  },
  {
    name: 'impact_analysis',
    description: 'Показывает какие файлы зависят от указанного файла или символа. Используй перед рефакторингом чтобы понять масштаб изменений.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Путь к файлу (относительный от корня проекта)' },
        symbol: { type: 'string', description: 'Имя символа (опц.) — если указан, ищет использования конкретного символа в зависимых файлах' }
      },
      required: ['file']
    }
  },
  {
    name: 'generate_html',
    description: 'Сохранить артефакт в формате HTML (КП, аудит, отчёт). Файл попадает в .verstak/artifacts/{YYYY-MM-DD}/ и открывается в preview pane. Используй для артефактов проекта, где важна визуальная структура.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Имя файла без расширения (например "kp-alfa-development").' },
        title: { type: 'string', description: 'Title для <title> и <h1> по умолчанию.' },
        content_html: { type: 'string', description: 'Готовый body-HTML. CSS можно добавить inline или через <style>. Никаких <html>/<head> — обёртка собирается автоматически.' }
      },
      required: ['filename', 'content_html']
    }
  },
  {
    name: 'attest_verification',
    description: 'Сформируй доказательство выполнения задачи (Definition of Done): команды проверки будут ПЕРЕПРОГНАНЫ системой, статус ставится по реальному exitCode (не по твоему слову). Вызови в КОНЦЕ задачи. Результат — артефакт {slug}.verification.html в .verstak/artifacts/ + pill с бейджем DoD: N/M. Если команда заблокирована денилистом — статус not_run, проверка остаётся ручной. changed_files сверяются с реально записанными файлами прогона (расхождения видны в артефакте).',
    parameters: {
      type: 'object',
      properties: {
        task_summary: { type: 'string', description: 'Краткое описание выполненной задачи (1-2 предложения).' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'Пути файлов (относительно корня проекта), которые ты заявляешь изменёнными.' },
        checks: {
          type: 'array',
          description: 'Проверки выполнения. Для каждой с командой система перепрогонит её и поставит passed/failed по exitCode. Без команды — ручная проверка (берётся твой summary, статус not_run). Максимум ~10 проверок с командой.',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Команда проверки (например "npm run type"). Будет перепрогнана системой. Опустить — для ручной проверки.' },
              status: { type: 'string', description: 'Опционально — твоя оценка статуса. ИГНОРИРУЕТСЯ для проверок с командой (статус ставит система по exitCode).' },
              summary: { type: 'string', description: 'Что проверяет (для ручных проверок — основной текст).' }
            }
          }
        },
        risks: { type: 'array', items: { type: 'string' }, description: 'Известные риски / что осталось непроверенным.' },
        ui_screenshot: { type: 'boolean', description: 'Если true — приложить последний browser_screenshot как UI-доказательство (если есть свежий).' }
      },
      required: ['task_summary']
    }
  },
  {
    name: 'memory_save',
    description: 'Сохраняет факт, решение или паттерн в долговременную память агента для этого проекта. Используй в конце сессии или когда обнаружен важный инсайт.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['fact', 'decision', 'bug', 'preference', 'pattern'], description: 'Тип записи' },
        content: { type: 'string', description: 'Содержание записи (1-3 предложения)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Теги для поиска (3-5 слов)' }
      },
      required: ['type', 'content', 'tags']
    }
  },
  {
    name: 'memory_search',
    description: 'Ищет в долговременной памяти агента релевантные факты о проекте. Используй в начале сессии или при столкновении с незнакомой частью кода.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        limit: { type: 'number', description: 'Максимум результатов (default 5)' }
      },
      required: ['query']
    }
  },
  {
    name: 'check_diagnostics',
    description: 'Запускает проверку типов TypeScript (tsc --noEmit) на проекте и возвращает список ошибок. Используй после правок файлов чтобы убедиться что нет регрессий.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Опциональный путь к файлу — если задан, фильтрует вывод только по этому файлу' }
      },
      required: []
    }
  },
  {
    name: 'conversation_search',
    description: 'Ищет по всем прошлым разговорам в этом проекте. Используй когда нужно вспомнить что обсуждали раньше, найти принятое решение или контекст прошлой сессии.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        limit: { type: 'number', description: 'Максимум результатов (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'core_memory_append',
    description: 'Добавляет текст в core memory (MEMORY.md или USER.md). Core memory всегда видна агенту в system prompt. Используй для записи важных фактов о проекте или предпочтениях пользователя.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: ['memory', 'user'], description: 'memory = о проекте (MEMORY.md), user = о пользователе (USER.md)' },
        content: { type: 'string', description: 'Текст для добавления в конец блока' }
      },
      required: ['block', 'content']
    }
  },
  {
    name: 'core_memory_replace',
    description: 'Заменяет фрагмент в core memory. Используй когда факт устарел или нужно обновить информацию.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: ['memory', 'user'], description: 'memory = о проекте, user = о пользователе' },
        old_text: { type: 'string', description: 'Существующий фрагмент для замены (должен точно совпадать)' },
        new_text: { type: 'string', description: 'Новый текст' }
      },
      required: ['block', 'old_text', 'new_text']
    }
  },
  {
    name: 'core_memory_remove',
    description: 'Удаляет фрагмент из core memory. Используй когда информация больше не актуальна.',
    parameters: {
      type: 'object',
      properties: {
        block: { type: 'string', enum: ['memory', 'user'], description: 'memory = о проекте, user = о пользователе' },
        text: { type: 'string', description: 'Текст для удаления (должен точно совпадать)' }
      },
      required: ['block', 'text']
    }
  },
  {
    name: 'convert_file',
    description: 'Конвертирует файл (DOCX, CSV, HTML, JSON, XML) в текст/markdown. Используй когда нужно прочитать не-текстовый файл.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу (относительно корня проекта)' }
      },
      required: ['path']
    }
  },
  {
    name: 'screen_capture',
    description: 'Делает скриншот экрана или активного окна Verstak. Скриншот прикрепляется к следующему сообщению как изображение — провайдеры с vision (Gemini, GPT-4o, Claude) увидят его и смогут проанализировать визуально. Используй для GUI-автоматизации, визуального анализа интерфейса или отладки.',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['screen', 'window'],
          description: 'screen = весь экран (default), window = активное окно Verstak'
        }
      },
      required: []
    }
  },
  {
    name: 'screen_info',
    description: 'Возвращает информацию о подключённых мониторах: разрешение, позиция, масштаб, первичный дисплей.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'generate_docx',
    description: 'Сохранить артефакт в формате Word (.docx). Файл попадает в .verstak/artifacts/{YYYY-MM-DD}/. Принимает структуру секций — каждая с heading и параграфами.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Имя файла без расширения.' },
        title: { type: 'string', description: 'Заголовок документа (большой шрифт сверху).' },
        sections: {
          type: 'array',
          description: 'Секции документа в порядке появления.',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'Заголовок секции (h2-стиль).' },
              level: { type: 'number', description: 'Уровень заголовка 1-3, по умолчанию 2.' },
              paragraphs: {
                type: 'array',
                description: 'Массив строк-параграфов.',
                items: { type: 'string' }
              },
              bullets: {
                type: 'array',
                description: 'Опциональный bulleted список после параграфов.',
                items: { type: 'string' }
              }
            },
            required: ['paragraphs']
          }
        }
      },
      required: ['filename', 'sections']
    }
  },
  {
    name: 'read_spreadsheet',
    description: 'Прочитать Excel-файл (.xlsx) и вернуть содержимое всех листов как текст: имя листа + строки в markdown-таблице. Большие листы обрезаются (до 200 строк / 40 столбцов) с пометкой. Используй когда пользователь просит разобрать таблицу, отчёт, выгрузку, прайс в .xlsx.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь к .xlsx от корня проекта.' } },
      required: ['path']
    }
  },
  {
    name: 'read_document',
    description: 'Прочитать Word-файл (.docx) и вернуть простой текст. Используй когда пользователь просит разобрать договор, ТЗ, бриф, документ в .docx.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Относительный путь к .docx от корня проекта.' } },
      required: ['path']
    }
  },
  {
    name: 'edit_spreadsheet',
    description: 'Записать значения в ячейки Excel-файла (.xlsx). Читает файл, меняет указанные ячейки, сохраняет на место. Требует подтверждения пользователя как обычный write. Используй для точечной правки таблицы (исправить цену, заполнить столбец, обновить значение).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Относительный путь к существующему .xlsx.' },
        sheet: { type: 'string', description: 'Имя листа. Если не задан — первый лист.' },
        edits: {
          type: 'array',
          description: 'Список правок ячеек.',
          items: {
            type: 'object',
            properties: {
              cell: { type: 'string', description: 'Ссылка на ячейку в A1-нотации, например "B2".' },
              value: { type: 'string', description: 'Новое значение. Числовые строки сохраняются числами.' }
            },
            required: ['cell', 'value']
          }
        }
      },
      required: ['path', 'edits']
    }
  }
]

/** SHA-256 hash of a trimmed line, first 8 hex chars. Used for anchor_hash safety check. */
export function hashLine(line: string): string {
  return createHash('sha256').update(line.trim()).digest('hex').slice(0, 8)
}

export interface FileTools {
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>
  /** Pure execution — used by the IPC layer after user has confirmed the command. */
  runCommand: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  classifyCommand: typeof classifyCommand
}

/**
 * Apply one or more SEARCH/REPLACE blocks to a string and return the result.
 * Each SEARCH must match EXACTLY ONCE in the current state of the buffer
 * (re-checked after each replacement so earlier rewrites don't break later
 * matches). Throws with a precise error if a block doesn't match or is
 * ambiguous — important so the AI sees feedback and can correct.
 */
export function applySearchReplaceBlocks(input: string, diff: string, anchorHash?: string): string {
  const blockRe = /<{7,}\s*SEARCH\s*\n([\s\S]*?)\n={7,}\s*\n([\s\S]*?)\n>{7,}\s*REPLACE\b/g
  let result = input
  let applied = 0
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(diff)) !== null) {
    const search = m[1]
    const replace = m[2]
    if (!search) {
      throw new Error(`apply_patch: пустой SEARCH блок в позиции ${applied + 1}`)
    }
    // Anchor hash check — only on the first block if anchor_hash is provided
    if (applied === 0 && anchorHash) {
      const firstLine = search.split('\n')[0]
      const actual = hashLine(firstLine)
      if (actual !== anchorHash) {
        throw new Error(`apply_patch: хэш якоря не совпадает — файл изменился. Ожидалось "${anchorHash}", получено "${actual}". Перечитай файл и составь патч по актуальному содержимому.`)
      }
    }
    // Primary: exact match
    let first = result.indexOf(search)
    let actualSearch = search
    if (first === -1) {
      // Fallback: normalize line endings (\r\n → \n) and trim trailing whitespace
      // on each line of both SEARCH and file content, then apply to the
      // normalized content directly (avoids fragile character-position
      // reconstruction that was unreliable on \r\n files and mixed tabs/spaces).
      const stripTrailing = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[\t ]+$/, '')).join('\n')
      const normSearch = stripTrailing(search)
      // Нормализуем result С КАРТОЙ позиций обратно в оригинал: splice'им только
      // matched-регион, а не переписываем весь файл из normResult — иначе нетронутые
      // строки теряли \r (CRLF→LF) и trailing whitespace (#5 data-loss на CRLF-проекте).
      const { norm: normResult, pos } = stripTrailingWithMap(result)
      const normFirst = normResult.indexOf(normSearch)
      if (normFirst !== -1) {
        const normNext = normResult.indexOf(normSearch, normFirst + 1)
        if (normNext !== -1) {
          throw new Error(`apply_patch: SEARCH блок #${applied + 1} после нормализации whitespace встречается несколько раз (позиции ${normFirst} и ${normNext}). Добавь контекста.`)
        }
        const origStart = pos[normFirst]
        const origEnd = pos[normFirst + normSearch.length]
        result = result.slice(0, origStart) + replace + result.slice(origEnd)
        applied++
        continue
      }
    }
    if (first === -1) {
      const sample = search.split('\n')[0].slice(0, 80)
      throw new Error(`apply_patch: SEARCH блок #${applied + 1} не найден в файле (даже после нормализации whitespace). Первая строка искомого: "${sample}". Прочитай файл заново и составь патч по актуальному содержимому.`)
    }
    if (actualSearch === search) {
      const nextEx = result.indexOf(search, first + 1)
      if (nextEx !== -1) {
        throw new Error(`apply_patch: SEARCH блок #${applied + 1} встречается в файле несколько раз (позиции ${first} и ${nextEx}). Добавь контекста до/после чтобы фрагмент стал уникальным.`)
      }
    }
    result = result.slice(0, first) + replace + result.slice(first + actualSearch.length)
    applied++
  }
  if (applied === 0) {
    throw new Error('apply_patch: в diff не найдено ни одного валидного SEARCH/REPLACE блока. Формат: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE')
  }
  return result
}

/**
 * Аналог stripTrailing (\r\n→\n + срез trailing [\t ] на каждой строке), но с
 * картой `pos`: pos[k] = индекс в ОРИГИНАЛЕ символа, ставшего norm[k] (pos[norm.length]
 * = длина оригинала). Позволяет whitespace-fallback'у apply_patch заменить только
 * matched-регион, сохранив байты (CRLF/trailing ws) на остальных строках.
 */
function stripTrailingWithMap(s: string): { norm: string; pos: number[] } {
  const out: string[] = []
  const pos: number[] = []
  let pending: Array<{ c: string; at: number }> = []
  let i = 0
  const n = s.length
  while (i < n) {
    let ch = s[i]
    let at = i
    if (ch === '\r' && s[i + 1] === '\n') { ch = '\n'; at = i + 1; i += 2 } else { i += 1 }
    if (ch === '\t' || ch === ' ') { pending.push({ c: ch, at }); continue }
    if (ch === '\n') { pending = []; out.push('\n'); pos.push(at); continue }
    for (const w of pending) { out.push(w.c); pos.push(w.at) }
    pending = []
    out.push(ch); pos.push(at)
  }
  pos.push(n) // sentinel: позиция за концом
  return { norm: out.join(''), pos }
}

// safeJoin / safeRealJoin moved to ./path-policy.ts — see import above.

function isRipgrepAvailable(): boolean {
  // Cheap probe — bare check if `rg` resolves. PATH lookup is sync via `where`/`which`
  try {
    if (process.platform === 'win32') {
      const paths = (process.env.PATH || '').split(';')
      for (const p of paths) {
        if (existsSync(join(p, 'rg.exe')) || existsSync(join(p, 'rg'))) return true
      }
    } else {
      const paths = (process.env.PATH || '').split(':')
      for (const p of paths) {
        if (existsSync(join(p, 'rg'))) return true
      }
    }
  } catch { /* ignore */ }
  return false
}

const RIPGREP_AVAILABLE = isRipgrepAvailable()

async function searchWithRipgrep(root: string, query: string, glob: string | undefined, ignoreCase: boolean, regex: boolean): Promise<string[]> {
  const args: string[] = ['--no-heading', '--line-number', '--color=never', '--max-count', '20', '--max-filesize', '512K']
  if (ignoreCase) args.push('-i')
  if (!regex) args.push('-F')
  if (glob) args.push('-g', glob)
  args.push(query)
  args.push('.')
  try {
    const { stdout } = await execFileAsync('rg', args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    return stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_HITS)
      .map(line => line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line)
  } catch (err) {
    const e = err as { code?: number; stdout?: string }
    // rg exits 1 when no matches — return empty
    if (e.code === 1) return []
    throw err
  }
}

async function searchFallback(root: string, query: string, glob: string | undefined, ignoreCase: boolean, regex: boolean): Promise<string[]> {
  void glob  // best-effort: glob filter ignored in fallback for simplicity
  const haystack = ignoreCase ? query.toLowerCase() : query
  const rx = regex ? new RegExp(query, ignoreCase ? 'i' : '') : null
  const results: string[] = []
  async function walk(dir: string) {
    if (results.length >= MAX_SEARCH_HITS) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      if (results.length >= MAX_SEARCH_HITS) return
      if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      if (st.isDirectory()) { await walk(abs); continue }
      if (st.size > 512 * 1024) continue
      let content: string
      try { content = await readFile(abs, 'utf8') } catch { continue }
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_SEARCH_HITS) return
        const line = lines[i]
        const cmp = ignoreCase ? line.toLowerCase() : line
        const hit = rx ? rx.test(line) : cmp.includes(haystack)
        if (hit) {
          const rel = relative(root, abs).replace(/\\/g, '/')
          const trimmed = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line
          results.push(`${rel}:${i + 1}:${trimmed}`)
        }
      }
    }
  }
  await walk(root)
  return results
}

async function findFiles(root: string, pattern: string): Promise<string[]> {
  // Simple glob matcher: convert ** and * and ?. For real-world usage, this is sufficient for navigation hints.
  const re = globToRegExp(pattern)
  const results: string[] = []
  async function walk(dir: string) {
    if (results.length >= 200) return
    let entries: string[]
    try { entries = await readdir(dir) } catch { return }
    for (const name of entries) {
      if (results.length >= 200) return
      if (IGNORE_DIRS.has(name)) continue
      const abs = join(dir, name)
      let st
      try { st = await stat(abs) } catch { continue }
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (st.isDirectory()) {
        if (re.test(rel)) results.push(rel + '/')
        await walk(abs)
      } else {
        if (re.test(rel)) results.push(rel)
      }
    }
  }
  await walk(root)
  return results
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        pattern += '[^/]*'
      }
    } else if (c === '?') {
      pattern += '[^/]'
    } else if ('.+()[]{}^$|\\'.includes(c)) {
      pattern += '\\' + c
    } else {
      pattern += c
    }
  }
  pattern += '$'
  return new RegExp(pattern)
}

export function createFileTools(root: string, signal?: AbortSignal): FileTools {
  async function runCommand(command: string) {
    // Spawn the shell ourselves so we can treeKill the entire process group on
    // Windows when Stop is pressed. execFileAsync only kills the top-level
    // cmd.exe — grandchild processes (node.exe spawned by npm scripts) are
    // orphaned. spawn() gives us the child handle we need for treeKill.
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    // Windows консоль по умолчанию пишет в OEM-кодировке (cp866 на ru-RU), а мы
    // декодируем stdout как UTF-8 ниже — без переключения кодовой страницы
    // русский вывод (npm/git/python) превращается в мойибейк. `chcp 65001`
    // переводит cmd.exe и его дочерние процессы на UTF-8 ПЕРЕД командой.
    // Тот же приём уже используется в terminal.ts и cli-auth.ts.
    const shellArgs = isWindows ? ['/d', '/s', '/c', `chcp 65001 > nul & ${command}`] : ['-c', command]

    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      const MAX_BUF = 4 * 1024 * 1024
      let settled = false
      const settle = (result: { stdout: string; stderr: string; exitCode: number }) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      // setEncoding('utf8') гарантирует UTF-8 декод и корректно склеивает
      // многобайтовые символы, разорванные на границе чанков (StringDecoder
      // буферизует незавершённую последовательность). Так же делают CLI-провайдеры.
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < MAX_BUF) stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < MAX_BUF) stderr += chunk
      })

      // Hard timeout — resolve with exitCode 124 (same as GNU timeout)
      const timer = setTimeout(() => {
        treeKill(child)
        settle({ stdout, stderr: stderr + '\nКоманда прервана по таймауту (60s)', exitCode: 124 })
      }, 60_000)

      // AbortSignal — Stop / Shift+Esc: kill the whole process tree on Windows
      // so npm run build → node.exe etc. are also terminated.
      let abortListener: (() => void) | null = null
      if (signal) {
        abortListener = () => {
          clearTimeout(timer)
          treeKill(child)
          settle({ stdout, stderr: stderr + '\nКоманда прервана пользователем', exitCode: 130 })
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        if (abortListener) signal?.removeEventListener('abort', abortListener)
        settle({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 })
      })

      child.on('error', (err: Error) => {
        clearTimeout(timer)
        if (abortListener) signal?.removeEventListener('abort', abortListener)
        settle({ stdout, stderr: err.message, exitCode: 1 })
      })
    })
  }

  return {
    classifyCommand,
    runCommand,

    async execute(name, args) {
      if (name === 'read_file') {
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Доступ запрещён политикой безопасности: ${relPath} (secrets/credentials)`)
        }
        const abs = await safeRealJoin(root, relPath)
        let st
        try {
          st = await stat(abs)
        } catch (err) {
          const e = err as NodeJS.ErrnoException
          if (e.code === 'ENOENT') {
            // Clearer guidance — model otherwise tends to retry the same path 3×
            throw new Error(`Файл "${relPath}" не существует в активном проекте (${root}). Вызови list_directory или get_project_map чтобы увидеть реальную структуру.`)
          }
          throw err
        }
        if (!st.isFile()) throw new Error(`Не файл: ${args.path}`)
        if (st.size > MAX_READ_BYTES) {
          throw new Error(`Файл слишком большой: ${st.size} байт (лимит ${MAX_READ_BYTES})`)
        }
        const raw = await readFile(abs, 'utf8')
        const scan = scanText(raw)
        if (scan.hits.length > 0) {
          // Add a header note so the AI knows redaction happened
          return `[secret-scanner: redacted ${scan.hits.join(', ')}]\n${scan.redacted}`
        }
        return raw
      }
      if (name === 'list_directory') {
        const abs = await safeRealJoin(root, String(args.path))
        const entries = await readdir(abs)
        const out: string[] = []
        for (const e of entries) {
          const childRel = (String(args.path) === '.' ? e : `${args.path}/${e}`)
          if (isForbiddenPath(childRel)) continue  // hide secret stores from directory listings
          const st = await stat(join(abs, e))
          out.push(st.isDirectory() ? `${e}/` : e)
        }
        return out
      }
      if (name === 'write_file') {
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Запись запрещена политикой безопасности: ${relPath}`)
        }
        const abs = await safeRealJoin(root, relPath)
        await writeFile(abs, String(args.content), 'utf8')
        // Incremental project map update — mark only this file dirty so the next
        // get_project_map re-parses it instead of doing a full rebuild.
        markFileDirty(root, abs)
        // Dependency map has no incremental path — re-resolving imports/importedBy
        // is non-trivial, so keep the full invalidation here.
        invalidateDependencyMap(root)
        return { ok: true }
      }
      if (name === 'apply_patch') {
        // Note: this branch should normally NOT be reached — ipc/ai.ts
        // intercepts apply_patch to wire it through the user-confirmation
        // flow, just like write_file. We keep an implementation here for
        // direct/test use.
        const relPath = String(args.path)
        if (isForbiddenPath(relPath)) {
          throw new Error(`Запись запрещена политикой безопасности: ${relPath}`)
        }
        const abs = await safeRealJoin(root, relPath)
        const before = await readFile(abs, 'utf8')
        const anchorHash = args.anchor_hash ? String(args.anchor_hash) : undefined
        const after = applySearchReplaceBlocks(before, String(args.diff), anchorHash)
        await writeFile(abs, after, 'utf8')
        // Incremental project map update — apply_patch only modifies an existing
        // file, so marking it dirty is enough; no full rebuild needed.
        markFileDirty(root, abs)
        invalidateDependencyMap(root)
        return { ok: true, before, after }
      }
      if (name === 'run_command') {
        // The IPC layer intercepts this tool call to gather user confirmation
        // BEFORE invoking execute. If we land here, it means the confirmation
        // flow was bypassed — fail loudly rather than silently executing.
        throw new Error('run_command нельзя вызывать напрямую — он проходит через подтверждение пользователя')
      }
      if (name === 'search_project') {
        const query = String(args.query ?? '')
        if (!query) throw new Error('search_project: пустой query')
        const glob = args.glob ? String(args.glob) : undefined
        const ignoreCase = args.ignoreCase !== false
        const regex = !!args.regex
        const rawHits = RIPGREP_AVAILABLE
          ? await searchWithRipgrep(root, query, glob, ignoreCase, regex)
          : await searchFallback(root, query, glob, ignoreCase, regex)
        // Drop hits from forbidden files and redact secret-looking matches
        const safeHits: string[] = []
        let redactionCount = 0
        for (const line of rawHits) {
          const idx = line.indexOf(':')
          const file = idx >= 0 ? line.slice(0, idx) : line
          if (isForbiddenPath(file)) continue
          const scan = scanText(line)
          if (scan.hits.length > 0) redactionCount++
          safeHits.push(scan.redacted)
        }
        return {
          matches: safeHits,
          truncated: safeHits.length >= MAX_SEARCH_HITS,
          backend: RIPGREP_AVAILABLE ? 'ripgrep' : 'fallback',
          ...(redactionCount > 0 ? { redactions: redactionCount } : {})
        }
      }
      if (name === 'find_files') {
        const pattern = String(args.pattern ?? '')
        if (!pattern) throw new Error('find_files: пустой pattern')
        const files = await findFiles(root, pattern)
        return { files, truncated: files.length >= 200 }
      }
      if (name === 'get_project_map') {
        const map = await getProjectMap(root, false)
        const fmt = String(args.format ?? 'text')
        return fmt === 'json' ? map : projectMapToText(map)
      }
      if (name === 'refresh_project_map') {
        invalidateProjectMap(root)
        const map = await getProjectMap(root, true)
        const fmt = String(args.format ?? 'text')
        return fmt === 'json' ? map : projectMapToText(map)
      }
      if (name === 'read_spreadsheet') {
        const { readSpreadsheet } = await import('./office')
        return readSpreadsheet(root, String(args.path ?? ''))
      }
      if (name === 'read_document') {
        const { readDocument } = await import('./office')
        return readDocument(root, String(args.path ?? ''))
      }
      throw new Error(`Неизвестный tool: ${name}`)
    }
  }
}

/**
 * FileTools для удалённого ssh-проекта (Вариант B): тот же контракт, но операции
 * идут на сервер через SshBackend. Подменяет createFileTools, когда проект ssh —
 * хендлеры и confirm-flow не меняются (они ходят через ctx.tools.execute).
 *
 * Безопасность: classifyCommand усилен ssh-denylist'ом; read/write проходят
 * escape-guard в backend; запись подтверждается mode-policy как у локальных.
 */
/**
 * Выбрать FileTools по project_path: ssh://… → удалённый ssh-backend (Вариант B),
 * иначе локальная ФС. Единая точка — agent-loop зовёт её вместо createFileTools.
 */
export function createToolsForProject(projectPath: string, signal?: AbortSignal): FileTools {
  const target = parseSshProjectPath(projectPath)
  if (target) {
    return createSshFileTools(createSshBackend(target.remoteRoot, makeSshExec(target, signal)))
  }
  return createFileTools(projectPath, signal)
}

export function createSshFileTools(backend: SshBackend): FileTools {
  return {
    classifyCommand(command: string) {
      const danger = isDangerousCommand(command)
      if (danger) return { allowed: false, reason: `ssh-denylist: ${danger}` }
      return classifyCommand(command)
    },
    async runCommand(command: string) {
      const r = await backend.runCommand(command)
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 }
    },
    async execute(name, args) {
      if (name === 'read_file') {
        const raw = await backend.readFile(String(args.path))
        const scan = scanText(raw)
        return scan.hits.length > 0
          ? `[secret-scanner: redacted ${scan.hits.join(', ')}]\n${scan.redacted}`
          : raw
      }
      if (name === 'list_directory') {
        return backend.listDir(String(args.path ?? '.'))
      }
      if (name === 'write_file') {
        await backend.writeFile(String(args.path), String(args.content ?? ''))
        return { ok: true }
      }
      if (name === 'apply_patch') {
        const before = await backend.readFile(String(args.path))
        const anchorHash = args.anchor_hash ? String(args.anchor_hash) : undefined
        const after = applySearchReplaceBlocks(before, String(args.diff), anchorHash)
        await backend.writeFile(String(args.path), after)
        return { ok: true, before, after }
      }
      if (name === 'run_command') {
        throw new Error('run_command нельзя вызывать напрямую — он проходит через подтверждение пользователя')
      }
      if (name === 'search_project') {
        const query = String(args.query ?? '')
        if (!query) throw new Error('search_project: пустой query')
        // fixed-string по умолчанию (экранируем как -F, но через -E для -n line-numbers).
        const pattern = args.regex ? query : query.replace(/[.[\]*+?^${}()|\\/]/g, '\\$&')
        const ic = args.ignoreCase !== false ? 'i' : ''
        const r = await backend.runCommand(`grep -rn${ic}E -- ${shq(pattern)} . 2>/dev/null | head -100`)
        const scan = scanText(r.stdout)
        return (scan.redacted.trim() || 'Ничего не найдено.')
      }
      throw new Error(`Удалённый ssh-проект: инструмент «${name}» пока не поддержан (доступны read_file/write_file/apply_patch/list_directory/search_project/run_command).`)
    },
  }
}
