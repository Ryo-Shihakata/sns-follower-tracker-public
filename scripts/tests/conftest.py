import sys
from pathlib import Path

# scripts/ 直下のスクリプトを `import resync_d1_from_local` できるようにする。
# collector パッケージ (httpx/respx 等の依存も含む) は resync_d1_from_local.py 自身が
# import 時に collector/src を sys.path に挿入するので、ここでは scripts/ だけ足せばよい。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
