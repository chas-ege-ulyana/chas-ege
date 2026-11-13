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
    echo "  -i, --interactive  Интерактивный режим (y/n/d для каждого silentpr)"
    exit 1
fi

echo "🔄 Подтягиваем свежие ветки из $SOURCE_REMOTE..."
git fetch "$SOURCE_REMOTE" --quiet

# Функция для интерактивного запрос
ask_action() {
    local ref="$1"
    local target_remote="$2"
    local branch_name="$3"
    local source_sha="$4"
    local target_sha="$5"
    local target_exists="$6"
    
    echo ""
    echo "📋 SilentPR: $ref"
    echo "   Целевой ремоут: $target_remote"
    echo "   Имя ветки: $branch_name"
    echo "   Source SHA: ${source_sha:0:9}"
    
    if [ "$target_exists" = "yes" ]; then
        echo "   Target SHA: ${target_sha:0:9}"
        
        # Проверяем отношение между ветками
        if [ "$source_sha" = "$target_sha" ]; then
            echo "   Статус: ✅ Ветки совпадают"
        elif git merge-base --is-ancestor "$source_sha" "$target_sha"; then
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
    
    echo ""
    echo "Действие? [y/n/d/?]"
    echo "  y - Запушить source в target (или обновить source если target опережает)"
    echo "  n - Пропустить этот silentpr"
    echo "  d - Удалить изменения: force reset source к target (сбросить к состоянию target)"
    echo "  ? - Показать эту справку"
    echo ""
    
    while true; do
        read -p "Ваш выбор: " choice
        case "$choice" in
            y|Y)
                echo "$choice"
                return
                ;;
            n|N)
                echo "$choice"
                return
                ;;
            d|D)
                echo "$choice"
                return
                ;;
            ?)
                echo ""
                echo "Доступные действия:"
                echo "  y - Запушить source в target (или обновить source если target опережает)"
                echo "  n - Пропустить этот silentpr"
                echo "  d - Удалить изменения: force reset source к target (сбросить к состоянию target)"
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
git for-each-ref --format="%(refname:short)" "refs/remotes/$SOURCE_REMOTE/silentpr/*/*" | while read -r ref; do
    # Разбиваем строку на массив по слешу
    IFS='/' read -ra parts <<< "$ref"
    target_remote="${parts[2]}"
    branch_name=$(IFS=/; echo "${parts[*]:3}")
    
    source_full_ref="refs/remotes/$ref"
    source_sha=$(git rev-parse "$source_full_ref")
    
    # Подтягиваем целевую ветку для сравнения
    git fetch "$target_remote" "$branch_name" --quiet 2>/dev/null
    target_ref="refs/remotes/$target_remote/$branch_name"
    
    target_exists="no"
    target_sha=""
    if git rev-parse "$target_ref" >/dev/null 2>&1; then
        target_exists="yes"
        target_sha=$(git rev-parse "$target_ref")
    fi
    
    # Интерактивный режим
    if [ "$INTERACTIVE" = true ]; then
        action=$(ask_action "$ref" "$target_remote" "$branch_name" "$source_sha" "$target_sha" "$target_exists")
        
        case "$action" in
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
        esac
        # action = y, продолжаем с обычным пушем
    fi
    
    # Автоматический режим или действие "y"
    if [ "$target_exists" = "yes" ]; then
        # Условие 1: если ветки совпадают — ничего не делаем и не пишем
        if [ "$source_sha" = "$target_sha" ]; then
            continue
        fi
        
        # Условие 2: если целевая опережает исходную — обновляем source (fast-forward push)
        if git merge-base --is-ancestor "$source_sha" "$target_sha"; then
            echo "🔄 Target опережает source, обновляем source..."
            git push "$SOURCE_REMOTE" "$target_sha:refs/heads/silentpr/$target_remote/$branch_name" --quiet 2>/dev/null
            echo "✅ Source обновлён"
            echo "-----------------------------------"
            continue
        fi
    fi
    
    # Обычный случай: исходная опережает целевую — пушим в целевой ремоут
    echo "🚀 Отправляем коммит $source_sha в ремоут '$target_remote' как ветку '$branch_name'..."
    git push "$target_remote" "$source_sha:refs/heads/$branch_name"
    
    if [ $? -eq 0 ]; then
        echo "✅ Успешно запушено!"
    else
        echo "❌ Ошибка пуша. Возможно, нет прав или ветка diverged."
    fi
    echo "-----------------------------------"
done
