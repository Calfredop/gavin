# Extensionless file: fileExtension("Makefile") returns "", which is not
# in VIEWABLE_EXTENSIONS -- so cmd+click must hand this to the OS default
# app, NOT open it in a pane.

.PHONY: check
check:
	cd app && npm run check && npm test
