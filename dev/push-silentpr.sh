#!/bin/bash
# Проверяем, передан ли исходный ремоут
SOURCE_REMOTE=""
INTERACTIVE=false

# Парсим аргументы
while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--interactive)
            INTERACTIVE=true
            shift
            ;;
        *)
            SOURCE_REMOTE="$1"
            shift
            ;;
    esac
done

if [ -z "$SOURCE_REMOTE" ]; then
    echo "Использование: $0 [-i] <source_remote>"
    echo "Пример: $0 chas-ege-ulyana"
    echo "Флаги:"
    echo "  -i, --interactive  Интерактивный режим (y/n/d/s для каждого silentpr)"
    exit 1
fi

echo "🔄 Подтягиваем свежие ветки из $SOURCE_REMOTE..."
# ВАЖНО: --quiet должен быть ПЕРЕД именем ремоута!
git fetch --quiet --prune "$SOURCE_REMOTE"

# Классифицирует характер изменений между деревьями a и b.
# Печатает системную метку (или ничего):
#   trimmed-whitespace only — только пробелы и только в началах/концах строк
#   whitespace-only         — только пробелы (включая пустые строки и пробелы внутри строк)
classify_whitespace() {
    local a="$1" b="$2" f trimmed=yes
    # Содержательных изменений нет вовсе (деревья совпадают) — метка не нужна
    if git diff --quiet "$a" "$b" 2>/dev/null; then
        return 0
    fi
    # Есть не-пробельные изменения?
    if [ -n "$(git diff --ignore-all-space --ignore-blank-lines "$a" "$b" 2>/dev/null)" ]; then
        return 0
    fi
    # Пробелы только по краям строк? Сравниваем файлы с обрезанными краями строк.
    while IFS= read -r -d '' f; do
        if ! git cat-file -e "$a:$f" 2>/dev/null || ! git cat-file -e "$b:$f" 2>/dev/null; then
            trimmed=no
            break
        fi
        if ! cmp -s \
            <(git show "$a:$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//') \
            <(git show "$b:$f" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'); then
            trimmed=no
            break
        fi
    done < <(git diff --name-only --no-renames -z "$a" "$b")
    if [ "$trimmed" = yes ]; then
        echo "trimmed-whitespace only"
    else
        echo "whitespace-only"
    fi
}

# Показывает изменения a..b: сообщение коммита (если он один), ws-метка, цветной diff
show_diff() {
    local a="$1" b="$2" note
    if [ "$(git rev-list --count --first-parent "$a..$b" 2>/dev/null)" = "1" ]; then
        echo "💬 Сообщение коммита $(git rev-parse --short "$b"):"
        git log -1 --format=%B "$b"
    fi
    note=$(classify_whitespace "$a" "$b")
    [ -n "$note" ] && echo "⚙️  $note"
    git diff --color=always --stat --patch "$a" "$b"
}

# Показывает один коммит: сообщение, ws-метка, цветной diff (для split-режима)
show_commit() {
    local c="$1" note
    echo "💬 Сообщение коммита $(git rev-parse --short "$c"):"
    git log -1 --format=%B "$c"
    note=$(classify_whitespace "$c^" "$c")
    [ -n "$note" ] && echo "⚙️  $note"
    git diff --color=always --stat --patch "$c^" "$c"
}

# Split-режим: пушим коммиты по одному, от старых к новым, до первого отказа/ошибки.
# --first-parent: идём по основной линии, чтобы каждый пуш был fast-forward.
split_push() {
    local base="$1" target_remote="$2" branch_name="$3" source_sha="$4"
    local c choice total i=0 pushed=0
    total=$(git rev-list --count --first-parent "$base..$source_sha")
    echo ""
    echo "✂️  Split-режим: коммитов к разбору: $total (от старых к новым)"
    # Список коммитов — в массив, чтобы не занимать stdin (он нужен для ответов)
    local commits=()
    mapfile -t commits < <(git rev-list --reverse --first-parent "$base..$source_sha")
    for c in "${commits[@]}"; do
        i=$((i+1))
        echo ""
        echo "── Коммит $i/$total ──"
        show_commit "$c"
        while true; do
            if ! read -r -p "Принять этот коммит? [y/n/?] " choice; then
                echo ""
                echo "⏹️  Ввод закончился (EOF) — выходим."
                exit 0
            fi
            case "$choice" in
                y|Y|n|N)
                    break
                    ;;
                '?')
                    echo "  y - запушить этот коммит и перейти к следующему"
                    echo "  n - остановиться (остальные коммиты останутся только в source)"
                    ;;
                *)
                    echo "Неизвестный выбор: $choice"
                    ;;
            esac
        done
        if [ "$choice" = n ] || [ "$choice" = N ]; then
            echo "⏹️  Останавливаемся: без этого коммита дальше по истории идти нельзя."
            break
        fi
        echo "🚀 Пушим коммит $(git rev-parse --short "$c") в '$target_remote' как '$branch_name'..."
        if git push "$target_remote" "$c:refs/heads/$branch_name"; then
            echo "✅ Коммит принят и запушен"
            pushed=$((pushed+1))
        else
            echo "❌ Ошибка пуша — останавливаемся."
            break
        fi
    done
    echo "📊 Принято коммитов: $pushed/$total"
    echo "-----------------------------------"
}

# Функция для интерактивного запроса.
# ВАЖНО:
#  - Вызывать напрямую, НЕ через $(...): весь текст должен идти на экран,
#    а не в переменную. Ответ возвращается в глобальной переменной ACTION.
#  - read читает stdin (терминал). Список веток в основном цикле читается
#    из FD 3, чтобы не конфликтовать с этим read (см. комментарий у цикла).
ask_action() {
    local ref="$1"
    local target_remote="$2"
    local branch_name="$3"
    local source_sha="$4"
    local target_sha="$5"
    local target_exists="$6"
    local choice

    echo ""
    echo "📋 SilentPR: $ref"
    echo "   Целевой ремоут: $target_remote"
    echo "   Имя ветки: $branch_name"
    echo "   Source SHA: ${source_sha:0:9}"

    if [ "$target_exists" = "yes" ]; then
        echo "   Target SHA: ${target_sha:0:9}"

        # Проверяем отношение между ветками (совпадения сюда уже не доходят)
        if git merge-base --is-ancestor "$source_sha" "$target_sha"; then
            echo "   Статус: ⚠️  Target опережает source (можно обновить source)"
        elif git merge-base --is-ancestor "$target_sha" "$source_sha"; then
            echo "   Статус: 🚀 Source опережает target (можно запушить)"
        else
            echo "   Статус: ❌ Ветки diverged (нужен merge/rebase)"
        fi
    else
        echo "   Target SHA: (не существует)"
        echo "   Статус: 🆕 Target не существует"
    fi

    # Diff перед вопросом — как у git add -p.
    # Оба коммита уже скачаны (fetch выше), так что diff локальный и быстрый.
    # Цвет форсируем (--color=always); пейджер — стандартный git-овский:
    # короткий diff выводится сразу (LESS=FRX), длинный листается (q — выход).
    # Заодно вычисляем SPLIT_BASE — базу для split-режима (действие s).
    SPLIT_BASE=""
    SPLIT_WHY=""
    local disp_a="" disp_b="" base="" base_name="" cand
    echo ""
    if [ "$target_exists" = "yes" ]; then
        if git merge-base --is-ancestor "$source_sha" "$target_sha"; then
            echo "📄 Diff source → target (что получит source при обновлении):"
            disp_a="$source_sha"
            disp_b="$target_sha"
            SPLIT_WHY="s недоступен: source отстаёт от target, пушить нечего (y обновит source)"
        else
            echo "📄 Diff target → source (что уйдёт в target при пуше):"
            disp_a="$target_sha"
            disp_b="$source_sha"
            if git merge-base --is-ancestor "$target_sha" "$source_sha"; then
                SPLIT_BASE="$target_sha"
            else
                SPLIT_WHY="s недоступен: ветки diverged, сначала нужен merge/rebase"
            fi
        fi
    else
        # Целевой ветки нет: сравниваем с общей базой (devel/main/master целевого ремоута)
        for cand in devel main master; do
            if git rev-parse --verify --quiet "refs/remotes/$target_remote/$cand" >/dev/null 2>&1; then
                base=$(git merge-base "$source_sha" "refs/remotes/$target_remote/$cand" 2>/dev/null)
                if [ -n "$base" ]; then
                    base_name="$target_remote/$cand"
                    break
                fi
            fi
        done
        if [ -z "$base" ] && git fetch --quiet "$target_remote" devel 2>/dev/null; then
            base=$(git merge-base "$source_sha" FETCH_HEAD 2>/dev/null)
            [ -n "$base" ] && base_name="$target_remote/devel"
        fi
        if [ -n "$base" ]; then
            echo "📄 Diff от общей базы с $base_name (ветка новая):"
            disp_a="$base"
            disp_b="$source_sha"
            SPLIT_BASE="$base"
        else
            echo "📄 Общей базы нет, показываю последний коммит source:"
            git show --color=always --stat "$source_sha"
            SPLIT_WHY="s недоступен: нет общей базы для отсчёта коммитов"
        fi
    fi
    if [ -n "$disp_a" ]; then
        show_diff "$disp_a" "$disp_b"
    fi

    echo ""
    echo "Действие? [y/n/d/s/?]"
    echo "  y - Запушить source в target (или обновить source если target опережает)"
    echo "  n - Пропустить этот silentpr"
    echo "  d - Удалить изменения: force reset source к target (сбросить к состоянию target)"
    echo "  s - Разбить на коммиты: принимать по одному, от старых к новым"
    echo "  ? - Показать эту справку"
    echo ""

    ACTION=""
    while true; do
        if ! read -r -p "Ваш выбор: " choice; then
            # EOF (Ctrl+D или закрытый stdin): не зацикливаемся, а завершаем работу
            echo ""
            echo "⏹️  Ввод закончился (EOF) — выходим."
            exit 0
        fi
        case "$choice" in
            y|Y)
                ACTION="y"
                return
                ;;
            n|N)
                ACTION="n"
                return
                ;;
            d|D)
                ACTION="d"
                return
                ;;
            s|S)
                if [ -n "$SPLIT_BASE" ]; then
                    ACTION="s"
                    return
                else
                    echo "$SPLIT_WHY"
                fi
                ;;
            '?')
                echo ""
                echo "Доступные действия:"
                echo "  y - Запушить source в target (или обновить source если target опережает)"
                echo "  n - Пропустить этот silentpr"
                echo "  d - Удалить изменения: force reset source к target (сбросить к состоянию target)"
                echo "  s - Разбить на коммиты: принимать по одному, от старых к новым"
                echo "  ? - Показать эту справку"
                echo ""
                ;;
            *)
                echo "Неизвестный выбор: $choice"
                ;;
        esac
    done
}

# Проходимся по всем remote-tracking веткам, которые лежат в silentpr/
# Формат: refs/remotes/<source>/silentpr/<target_remote>/<branch_name>
# ВАЖНО:
#  - Список веток читаем из FD 3 (<&3), а stdin оставляем терминалу:
#    при `git for-each-ref | while read` интерактивный read внутри цикла
#    съедал строки списка веток вместо ответов пользователя, а на EOF
#    зацикливался намертво — скрипт "подвисал" сразу после fetch.
#  - Паттерн — префикс silentpr (без /*/*): у for-each-ref '*' не пересекает
#    '/', поэтому /*/* терял ветки с '/' в имени (например silentpr/bob/fix/typo).
while IFS= read -r ref <&3; do
    # Разбиваем строку на массив по слешу
    IFS='/' read -ra parts <<< "$ref"
    # Пропускаем ссылки без имени ветки (silentpr/<target> и короче)
    if [ "${#parts[@]}" -lt 4 ]; then
        continue
    fi
    target_remote="${parts[2]}"
    branch_name=$(IFS=/; echo "${parts[*]:3}")

    source_full_ref="refs/remotes/$ref"
    source_sha=$(git rev-parse "$source_full_ref")

    # Подтягиваем целевую ветку для сравнения
    # ВАЖНО: --quiet должен быть ПЕРЕД именем ремоута!
    git fetch --quiet "$target_remote" "$branch_name" 2>/dev/null
    target_ref="refs/remotes/$target_remote/$branch_name"

    target_exists="no"
    target_sha=""
    if git rev-parse "$target_ref" >/dev/null 2>&1; then
        target_exists="yes"
        target_sha=$(git rev-parse "$target_ref")
    fi

    # Ветки совпадают — молча пропускаем в любом режиме, без вопросов
    if [ "$target_exists" = "yes" ] && [ "$source_sha" = "$target_sha" ]; then
        continue
    fi

    # Интерактивный режим
    if [ "$INTERACTIVE" = true ]; then
        ask_action "$ref" "$target_remote" "$branch_name" "$source_sha" "$target_sha" "$target_exists"

        case "$ACTION" in
            n)
                echo "⏭️  Пропускаем $ref"
                echo "-----------------------------------"
                continue
                ;;
            d)
                echo "🗑️  Force reset source к target..."
                if [ "$target_exists" = "yes" ]; then
                    git push --force "$SOURCE_REMOTE" "$target_sha:refs/heads/silentpr/$target_remote/$branch_name" --quiet 2>/dev/null
                    if [ $? -eq 0 ]; then
                        echo "✅ Source сброшен к состоянию target"
                    else
                        echo "❌ Ошибка force reset"
                    fi
                else
                    echo "❌ Target не существует, нечего сбрасывать"
                fi
                echo "-----------------------------------"
                continue
                ;;
            s)
                split_push "$SPLIT_BASE" "$target_remote" "$branch_name" "$source_sha"
                continue
                ;;
        esac
        # ACTION = y, продолжаем с обычным пушем
    fi

    # Автоматический режим или действие "y"
    # Если целевая опережает исходную — обновляем source (fast-forward push)
    if [ "$target_exists" = "yes" ] && git merge-base --is-ancestor "$source_sha" "$target_sha"; then
        echo "🔄 Target опережает source, обновляем source..."
        git push "$SOURCE_REMOTE" "$target_sha:refs/heads/silentpr/$target_remote/$branch_name" --quiet 2>/dev/null
        echo "✅ Source обновлён"
        echo "-----------------------------------"
        continue
    fi

    # Обычный случай: исходная опережает целевую — пушим в целевой ремоут
    echo "🚀 Отправляем коммит $source_sha в ремоут '$target_remote' как ветку '$branch_name'..."
    # ВАЖНО: Пушим именно SHA коммита, а не refs/remotes/...!
    # Иначе GitHub выдаст permission denied из-за cross-fork push protection
    git push "$target_remote" "$source_sha:refs/heads/$branch_name"

    if [ $? -eq 0 ]; then
        echo "✅ Успешно запушено!"
    else
        echo "❌ Ошибка пуша. Возможно, нет прав или ветка diverged."
    fi
    echo "-----------------------------------"
done 3< <(git for-each-ref --format="%(refname:short)" "refs/remotes/$SOURCE_REMOTE/silentpr")
