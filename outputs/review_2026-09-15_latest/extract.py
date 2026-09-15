import sys
from pathlib import Path
sys.path.insert(0,str(Path('outputs/review_2026-09-15_latest/pythonlibs').resolve()))
import fitz
out=Path('outputs/review_2026-09-15_latest')
for batch in ['34945709484','34822439450']:
 for lang in ['','_en']:
  p=Path.home()/f'Downloads/monthly-report-pdfs-{batch}/latest_report{lang}.pdf'
  d=fitz.open(p)
  text='\n'.join(f'\n=== PAGE {i+1} ===\n'+page.get_text() for i,page in enumerate(d))
  (out/f'{batch}{lang}.txt').write_text(text,encoding='utf-8')
  print(batch,lang,len(d),d.metadata)
  if batch=='34945709484' and not lang:
   print(text)
   for i in [1,2,3,len(d)-1]:d[i].get_pixmap(matrix=fitz.Matrix(1.3,1.3)).save(str(out/f'ko-{i+1}.png'))
