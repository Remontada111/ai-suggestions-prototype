from pydantic import BaseModel
from datetime import datetime

class Insight(BaseModel):
    adset_id: str
    ts_start: datetime          # början av 15-minuters­fönstret
    impressions: int
    clicks: int
    spend: float
    ctr: float                  # reduntant för snabb access
    roas: float
    budget: float               # gällande budget just då
    cpm: float                  # kostnad per tusen visningar
    cpc: float                  # kostnad per klick