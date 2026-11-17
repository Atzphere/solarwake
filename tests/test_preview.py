import asyncio
from types import SimpleNamespace

from app.model import Settings
from app.preview import Preview


class FakeDevice:
    def __init__(self):
        self.commands = []

    async def get_state(self, entity):
        return {'state':'off', 'attributes':{}}

    async def set_brightness(self, entity, pct):
        self.commands.append(('on',entity,pct))

    async def turn_off(self, entity):
        self.commands.append(('off',entity))


def test_preview_curve_and_length():
    store=SimpleNamespace(settings=Settings(ramp_minutes=1,fade_minutes=1,gamma=2))
    preview=Preview(store,FakeDevice())
    assert preview._target(0)==1
    assert preview._target(30) > 1
    assert preview._target(60)==100
    assert preview._target(180)==100
    assert preview._target(240)==0


def test_live_requires_disabled_alarm():
    async def run():
        preview=Preview(SimpleNamespace(settings=Settings(enabled=True)),FakeDevice())
        try:
            await preview.start(10, True)
        except ValueError as e:
            assert 'Disable' in str(e)
        else:
            raise AssertionError('live preview allowed with enabled alarm')
    asyncio.run(run())


def test_live_stop_restores_off_state():
    async def run():
        device=FakeDevice()
        preview=Preview(SimpleNamespace(settings=Settings(enabled=False)),device)
        await preview.start(60,True)
        await asyncio.sleep(.01)
        await preview.stop()
        assert device.commands[-1] == ('off','light.e80s_id')
        assert not preview.active()
    asyncio.run(run())
