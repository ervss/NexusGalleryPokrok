from .registry import ExtractorRegistry
from .eporner import EpornerExtractor
from .gofile import GoFileExtractor
from .porntrex import PorntrexExtractor
from .whoreshub import WhoresHubExtractor
from .turbo import TurboExtractor
from .bunkr import BunkrExtractor
from .camwhores import CamwhoresExtractor
from .ixxx import IxxxExtractor
from .filester import FilesterExtractor
from .leakporner import LeakPornerExtractor
from .pornhoarder import PornHoarderExtractor
from .archivebate import ArchivebateExtractor
from .recurbate import RecurbateExtractor
from .noodlemagazine import NoodleMagazineExtractor


def init_registry():
    existing_names = [e.name for e in ExtractorRegistry.get_all()]
    if "Eporner" not in existing_names:
        ExtractorRegistry.register(EpornerExtractor())
    if "Gofile" not in existing_names and "GoFile" not in existing_names:
        ExtractorRegistry.register(GoFileExtractor())
    if "PornTrex" not in existing_names:
        ExtractorRegistry.register(PorntrexExtractor())
    if "WhoresHub" not in existing_names:
        ExtractorRegistry.register(WhoresHubExtractor())
    if "Turbo" not in existing_names:
        ExtractorRegistry.register(TurboExtractor())
    if "Bunkr" not in existing_names:
        ExtractorRegistry.register(BunkrExtractor())
    if "Camwhores" not in existing_names:
        ExtractorRegistry.register(CamwhoresExtractor())
    if "iXXX" not in existing_names:
        ExtractorRegistry.register(IxxxExtractor())
    if "Filester" not in existing_names:
        ExtractorRegistry.register(FilesterExtractor())
    if "LeakPorner" not in existing_names:
        ExtractorRegistry.register(LeakPornerExtractor())
    if "PornHoarder" not in existing_names:
        ExtractorRegistry.register(PornHoarderExtractor())
    if "Archivebate" not in existing_names:
        ExtractorRegistry.register(ArchivebateExtractor())
    if "Recurbate" not in existing_names:
        ExtractorRegistry.register(RecurbateExtractor())
    if "NoodleMagazine" not in existing_names:
        ExtractorRegistry.register(NoodleMagazineExtractor())


def register_extended_extractors():
    from .xvideos import XVideosExtractor
    from .spankbang import SpankBangExtractor
    from .nsfw247 import NSFW247Extractor
    from .vk import VKExtractor
    from .xhamster import XHamsterExtractor
    from .pornhub import PornhubExtractor
    existing_names = [e.name for e in ExtractorRegistry.get_all()]
    if "XVideos" not in existing_names:
        ExtractorRegistry.register(XVideosExtractor())
    if "SpankBang" not in existing_names:
        ExtractorRegistry.register(SpankBangExtractor())
    if "NSFW247" not in existing_names:
        ExtractorRegistry.register(NSFW247Extractor())
    if "VK" not in existing_names:
        ExtractorRegistry.register(VKExtractor())
    if "xHamster" not in existing_names:
        ExtractorRegistry.register(XHamsterExtractor())
    if "Pornhub" not in existing_names:
        ExtractorRegistry.register(PornhubExtractor())


init_registry()
