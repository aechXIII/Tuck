try:
    from .app import main
except ImportError:
    from tuck.app import main

if __name__ == "__main__":
    import sys

    sys.exit(main())
