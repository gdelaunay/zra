"""Lecture read-only de l'index des threads agent de Zed (Windows).

Ne modifie rien : ouverture SQLite en mode=ro, Zed peut tourner en parallele.
"""
import os
import sqlite3

HOME = os.path.expanduser("~")
SIDEBAR_DB = os.path.join(HOME, "AppData", "Local", "Zed", "db", "0-stable", "db.sqlite")
THREADS_DB = os.path.join(HOME, "AppData", "Local", "Zed", "threads", "threads.db")


def ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path.replace("\\", "/"), uri=True)


con = ro(SIDEBAR_DB)

print("=== sidebar_threads : 8 plus recents ===")
for row in con.execute(
    "select agent_id, session_id, substr(title,1,50), updated_at, folder_paths "
    "from sidebar_threads order by updated_at desc limit 8"
):
    print(row)

print("\n=== repartition par agent_id ===")
for row in con.execute(
    "select agent_id, count(*) from sidebar_threads group by agent_id"
):
    print(row)

print("\n=== threads.db (ancien store natif) ===")
con2 = ro(THREADS_DB)
for row in con2.execute(
    "select id, substr(summary,1,40), updated_at, data_type, length(data) "
    "from threads order by updated_at desc limit 5"
):
    print(row)
