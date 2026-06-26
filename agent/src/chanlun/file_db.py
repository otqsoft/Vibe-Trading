import datetime
import pathlib
import random

import pandas as pd
import pytz

from chanlun import fun
from chanlun.base import Market
from chanlun.config import get_data_path
from chanlun.db import db


class FileCacheDB(object):
    """
    文件数据对象
    """

    def __init__(self):
        self.home_path = pathlib.Path.home()
        self.project_path = get_data_path()
        if self.project_path.is_dir() is False:
            self.project_path.mkdir()
        self.klines_path = self.project_path / "klines"
        if self.klines_path.is_dir() is False:
            self.klines_path.mkdir()
        self.cache_pkl_path = self.project_path / "cache_pkl"
        if self.cache_pkl_path.is_dir() is False:
            self.cache_pkl_path.mkdir()

        # 遍历 enum 中的值
        for market in Market:
            market_klines_path = self.klines_path / market.value
            if market_klines_path.is_dir() is False:
                market_klines_path.mkdir()

        # 设置时区
        self.tz = pytz.timezone("Asia/Shanghai")

    def get_tdx_klines(self, market: str, code: str, frequency: str):
        """
        获取缓存在文件中的股票数据
        """
        file_pathname = (
            self.klines_path / market / f"{code.replace('.', '_')}_{frequency}.csv"
        )
        if file_pathname.is_file() is False:
            return None
        try:
            _klines = pd.read_csv(file_pathname)
        except Exception:
            file_pathname.unlink()
            return None
        if len(_klines) > 0:
            _klines["date"] = pd.to_datetime(_klines["date"])
            if _klines["date"].isnull().any():
                return None
            _klines = _klines.iloc[0:-1:]

        # 加一个随机概率，去清理历史的缓存，避免太多占用空间
        if random.randint(0, 1000) <= 5:
            self.clear_tdx_old_klines(market)
        return _klines

    def save_tdx_klines(self, market: str, code: str, frequency: str, kline: pd.DataFrame):
        """
        保存通达信k线数据对象到文件中
        """
        file_pathname = (
            self.klines_path / market / f"{code.replace('.', '_')}_{frequency}.csv"
        )
        kline.to_csv(file_pathname, index=False)
        return True

    def clear_tdx_old_klines(self, market):
        """
        删除15天前的k线数据，不活跃的，减少占用空间
        """
        del_lt_times = fun.datetime_to_int(datetime.datetime.now()) - (
            15 * 24 * 60 * 60
        )
        for filename in (self.klines_path / market).glob("*.csv"):
            try:
                if filename.stat().st_mtime < del_lt_times:
                    filename.unlink()
            except Exception:
                pass
        return True

    def cache_pkl_to_file(self, filename: str, data: object):
        """
        将缓存数据持久化到文件中
        """
        import pickle
        with open(self.cache_pkl_path / filename, "wb") as fp:
            pickle.dump(data, fp)

    def cache_pkl_from_file(self, filename: str) -> object:
        """
        从文件中读取数据
        """
        import pickle
        if (self.cache_pkl_path / filename).is_file() is False:
            return None
        with open(self.cache_pkl_path / filename, "rb") as fp:
            return pickle.load(fp)


fdb = FileCacheDB()
