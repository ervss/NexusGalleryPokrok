import sqlite3
import os
import sys
import asyncio
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
sys.path.append(os.getcwd())

from app.extractors.vidara import VidaraExtractor
from app.extractors.lulustream import LuluStreamExtractor

async def repair_videos():
    conn = sqlite3.connect('videos.db')
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, source_url, url FROM videos 
        WHERE (title = '>External Link!<' OR title = 'Vidara Video' OR title IS NULL OR title = '')
        AND (source_url LIKE '%vidara.so%' OR url LIKE '%vidara.so%'
             OR source_url LIKE '%lulustream.com%' OR url LIKE '%lulustream.com%')
    """)
    rows = cursor.fetchall()
    
    vidara = VidaraExtractor()
    lulu = LuluStreamExtractor()
    
    updated_count = 0
    for vid_id, source_url, stream_url in rows:
        target = source_url if 'vidara.so' in source_url or 'lulustream.com' in source_url else stream_url
        logger.info(f"Repairing video {vid_id}: {target}")
        extractor = vidara if 'vidara.so' in target else lulu
        try:
            result = await extractor.extract(target)
            if result and result.get('stream_url'):
                cursor.execute("UPDATE videos SET title = ?, url = ?, thumbnail_path = ? WHERE id = ?",
                             (result['title'], result['stream_url'], result.get('thumbnail'), vid_id))
                updated_count += 1
        except Exception as e:
            logger.error(f"Error {vid_id}: {e}")
            
    conn.commit()
    conn.close()
    logger.info(f"Repaired {updated_count} videos.")

if __name__ == "__main__":
    asyncio.run(repair_videos())
