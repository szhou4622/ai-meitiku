"""小红书短链接重定向兼容性测试。"""

from __future__ import annotations

import unittest

from httpx import MockTransport, Request, Response
from xhs_adapters.config import AppSettings
from xhs_adapters.http import HttpxGateway


class HttpxGatewayRedirectTest(unittest.IsolatedAsyncioTestCase):
    """验证平台二次跳转登录时仍保留作品地址。"""

    async def test_resolve_keeps_supported_work_url_before_login(self) -> None:
        """最终跳到登录页时返回重定向历史中的作品地址。"""
        short_url = "https://xhslink.cn/o/synthetic"
        work_url = (
            "https://www.xiaohongshu.com/discovery/item/synthetic-work"
            "?xsec_token=synthetic-token&xsec_source=app_share"
        )
        login_url = "https://www.xiaohongshu.com/login?redirectPath=%2Fdiscovery%2Fitem"

        def handler(request: Request) -> Response:
            if str(request.url) == short_url:
                return Response(302, headers={"Location": work_url}, request=request)
            if str(request.url) == work_url:
                return Response(302, headers={"Location": login_url}, request=request)
            return Response(200, text="login", request=request)

        gateway = HttpxGateway(
            AppSettings(max_retry=0),
            transport=MockTransport(handler),
        )
        try:
            self.assertEqual(await gateway.resolve(short_url), work_url)
        finally:
            await gateway.close()


if __name__ == "__main__":
    unittest.main()
