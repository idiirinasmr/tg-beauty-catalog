#!/bin/bash
# Ежедневный бэкап PostgreSQL (раздел 12 плана).
# Cron на VPS:  0 3 * * * /opt/beauty-saas/server/scripts/backup.sh >> /var/log/beauty-saas/backup.log 2>&1
# Результат пишется в таблицу backup_log — его видят /backup в боте владельца и алерт в 09:00.

set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a

DATE=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR=${BACKUP_DIR:-/home/backups/beauty-saas}
FILE="$BACKUP_DIR/db_$DATE.sql.gz"
mkdir -p "$BACKUP_DIR"

log_result() { # $1 = true|false, $2 = размер, $3 = сообщение
    psql "$DIRECT_URL" -q -c "INSERT INTO backup_log (id, ok, size_bytes, message) VALUES (gen_random_uuid(), $1, $2, '$(echo "$3" | sed "s/'/''/g" | head -c 500)')" \
        || echo "Не удалось записать результат в backup_log"
}

# pg_dump через прямое подключение (DIRECT_URL), не через pgbouncer
if ! pg_dump "$DIRECT_URL" --no-owner --no-privileges | gzip > "$FILE"; then
    log_result false 0 "pg_dump завершился с ошибкой"
    exit 1
fi

SIZE=$(stat -c %s "$FILE")
if [ "$SIZE" -lt 1000 ]; then
    log_result false "$SIZE" "Файл бэкапа подозрительно маленький"
    exit 1
fi

# Копия в Supabase Storage (бакет backups, приватный)
if [ -n "${SUPABASE_SERVICE_KEY:-}" ]; then
    curl -sf -X POST "$SUPABASE_URL/storage/v1/object/backups/db_$DATE.sql.gz" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
        -H "Content-Type: application/gzip" \
        --data-binary @"$FILE" > /dev/null \
        || echo "Внимание: копия в Supabase Storage не загружена"
fi

# Удаление локальных бэкапов старше 30 дней
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +30 -delete

log_result true "$SIZE" "OK"
echo "$(date) бэкап готов: $FILE ($SIZE байт)"
