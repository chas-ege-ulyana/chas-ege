#!/bin/bash
# Проверяем, передан ли исходный ремоут
SOURCE_REMOTE=$1
if [ -z "$SOURCE_REMOTE" ]; then
    echo "Использование: $0 <source_remote>"
    echo "Пример: $0 chas-ege-ulyana"
    exit 1
fi

echo "🔄 Подтягиваем свежие ветки из $SOURCE_REMOTE..."
git fetch "$SOURCE_REMOTE" --quiet

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
    
    if git rev-parse "$target_ref" >/dev/null 2>&1; then
        target_sha=$(git rev-parse "$target_ref")
        
        # Условие 1: если ветки совпадают — ничего не делаем и не пишем
        if [ "$source_sha" = "$target_sha" ]; then
            continue
        fi
        
        # Условие 2: если целевая опережает исходную — обновляем source (fast-forward push)
        if git merge-base --is-ancestor "$source_sha" "$target_sha"; then
            git push "$SOURCE_REMOTE" "$target_ref:refs/heads/silentpr/$target_remote/$branch_name" --quiet 2>/dev/null
            continue
        fi
    fi
    
    # Обычный случай: исходная опережает целевую — пушим в целевой ремоут
    echo "🚀 Отправляем $ref в ремоут '$target_remote' как ветку '$branch_name'..."
    git push "$target_remote" "$source_full_ref:refs/heads/$branch_name"
    
    if [ $? -eq 0 ]; then
        echo "✅ Успешно запушено!"
    else
        echo "❌ Ошибка пуша. Возможно, нет прав или ветка diverged."
    fi
    echo "-----------------------------------"
done
