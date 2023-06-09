const playwright = require("playwright");
const {
	blockAds,
	blockSocials,
	gotoMuiPage,
	runWithRequestDiagnostics,
} = require("./mui-utils");

describe.each(["chromium", "firefox"])("%s", (browserType) => {
	/**
	 * @type {import('playwright').Browser}
	 */
	let browser;

	beforeAll(async () => {
		browser = await playwright[browserType].launch();
	});

	afterAll(async () => {
		const closingBrowser = browser;
		browser = null;
		await closingBrowser.close();
	});

	it("/", async () => {
		const page = await browser.newPage();
		await blockSocials(page);
		await gotoMuiPage(page, "/");
		const tree = await page.accessibility.snapshot({ interestingOnly: false });

		expect(
			pruneA11yTree(tree, {
				makeStableNode: (node, index, siblings) => {
					// is praise quote?
					const heading = siblings
						.slice(0, index)
						.reverse()
						.find((sibling) => {
							return sibling.role === "heading";
						});
					if (
						heading !== undefined &&
						heading.name === "Praise for MUI" &&
						node.role === "link"
					) {
						return {
							...node,
							children: [],
							name: "a random quote about MUI",
						};
					}

					const previous = siblings[index - 1];

					if (
						previous !== undefined &&
						previous.name === "Get Professional Support"
					) {
						return {
							...node,
							children: undefined,
							name: "random sponsor",
						};
					}

					// is quick word?
					if (
						previous !== undefined &&
						previous.name === "A quick word from our sponsors:"
					) {
						return {
							...node,
							children: undefined,
							name: "a random quick word",
						};
					}

					const next = siblings[index + 1];
					// is diamond sponsor in nav?
					if (
						isTextNode(previous) &&
						previous.name === "Diamond Sponsors" &&
						next !== undefined &&
						next.role === "link" &&
						next.name === "Diamond Sponsors"
					) {
						return null;
					}

					if (node.name === "Toggle notifications panel") {
						return {
							...node,
							children: (node.children || []).filter((notificationsChild) => {
								if (
									isTextNode(notificationsChild) &&
									!Number.isNaN(+notificationsChild.name)
								) {
									return false;
								}
								return true;
							}),
						};
					}

					return node;
				},
			})
		).toMatchSnapshot();
	});

	// markdowndocs
	it.each([
		"/api/button/",
		"/api/select/",
		"/components/breadcrumbs",
		"/components/buttons/",
		"/components/button-group/",
		"/components/cards/",
		"/components/checkboxes/",
		"/components/dialogs/",
		"/components/pickers",
		"/components/radio-buttons",
		"/components/selects/",
		"/components/slider",
		"/components/switches/",
		"/components/tabs/",
		"/components/text-fields/",
		"/components/tooltips/",
		"/components/transfer-list",
		// lab
		"/components/pagination/",
		"/components/rating/",
		"/components/tree-view/",
	])(`%s`, async (docsRoute) => {
		const page = await browser.newPage();
		await blockAds(page);

		await runWithRequestDiagnostics(page, () => {
			return gotoMuiPage(page, docsRoute);
		});
		const main = await page.$("main");
		const tree = await page.accessibility.snapshot({
			interestingOnly: false,
			root: main,
		});

		expect(
			pruneA11yTree(tree, {
				makeStableNode: (node, index, siblings) => {
					const previous = siblings[index - 1];
					if (
						node.role === "paragraph" &&
						previous !== undefined &&
						previous.role === "heading" &&
						previous.level === 1
					) {
						// first entry is description, rest is ads
						const [descriptionNode] = node.children;
						const adBlockerHintOffset = descriptionNode.name.indexOf(
							"Help us keep running"
						);
						if (adBlockerHintOffset === -1) {
							return { ...node, children: [descriptionNode] };
						}

						const description = descriptionNode.name.slice(
							0,
							adBlockerHintOffset
						);
						return {
							...node,
							children: [{ ...descriptionNode, name: description }],
						};
					}

					if (node.role === "code") {
						return { ...node, name: "$SOME_CODE", children: [] };
					}

					return node;
				},
			})
		).toMatchSnapshot();
	});
});

/**
 * // Should be importable as SerializedAXNode in ^1.1.2 (https://github.com/microsoft/playwright/pull/2722)
 * @typedef {NonNullable<ReturnType<import('playwright').Accessibility['snapshot']> extends Promise<infer R> ? R : never>} AXNode
 */

/**
 *
 * @param {AXNode} left
 * @param {AXNode} right
 * @returns {boolean} - true if only both are text nodes and only their text content is different
 */
function textNodesOnlyDifferInText(left, right) {
	if (isTextNode(left) && isTextNode(right)) {
		// I don't know if role: "text" has other properties that might be different
		// so I'm prematurely checking
		const keysOfDifferentValues = Array.from(
			new Set([...Object.keys(left), ...Object.keys(right)])
		).filter((key) => left[key] !== right[key]);

		// for text roles the accessible name is the content
		return (
			keysOfDifferentValues.length === 1 && keysOfDifferentValues[0] === "name"
		);
	}
	return false;
}

// join neighboring text nodes
function squashTextNodes(children) {
	if (children === undefined) {
		return undefined;
	}

	const squashedChildren = [];
	for (const child of children) {
		const previous = squashedChildren[squashedChildren.length - 1];
		if (previous !== undefined && textNodesOnlyDifferInText(previous, child)) {
			const start = squashedChildren.length - 1;
			const deleteCount = 1;
			const item = {
				...previous,
				name: previous.name + child.name,
			};
			squashedChildren.splice(start, deleteCount, item);
		} else {
			squashedChildren.push(child);
		}
	}

	return squashedChildren;
}

/**
 * prune axNode by
 * - squashing neighbouring text nodes otherwise there's a lot of noise in code blocks
 * - only including flattened children of `role="generic"`
 * @param {AXNode} node
 * @param {object} options
 * @param {(node: AXNode) => AXNode | null} options.makeStableNode - return `null` to remove the node
 */
function pruneA11yTree(node, options) {
	const { makeStableNode } = options;

	// Ignore netlify drawer which is not rendered on branch deploys.
	// Since we check in the snapshot of branch deploys but use PR deploys for diffing we always get a diff.
	// In other words: We remove any different that is expected between branch and PR deploys.
	if (node.role.toLowerCase() === "iframe" && node.name === "Netlify Drawer") {
		return undefined;
	}

	const children = makeStableChildren(
		squashTextNodes(pruneChildren(node.children))
	);

	// Remove ListMarker which is unstable (sometimes they're included, sometimes not)
	// I don't find them interesting anyway.
	if (node.role === "listitem") {
		if (children !== undefined && isListMarker(children[0])) {
			return {
				...node,
				// Remove ListMarker
				children: children.slice(1),
				// Firefox includes the ListMarker in the name of the listitem; remove it.
				name: node.name.startsWith(children[0].name)
					? // Remove `${marker} `
					  node.name.slice(children[0].name.length)
					: node.name,
			};
		}
	}

	// chromium: generic, firefox: section
	if (node.role === "generic" || node.role === "section") {
		return children;
	}
	// firefox only
	// unknown what this does but empty ones are mostly used for ads
	if (node.role === "text container") {
		return children;
	}
	if (children === undefined) {
		return node;
	}

	return {
		...node,
		children,
	};

	function pruneChildren(children) {
		if (children === undefined) {
			return undefined;
		}
		return children
			.flatMap((child) => {
				// `text` descendants of `link` already contribute to its name.
				if (
					node.role === "link" &&
					// firefox also has `text container`
					(isTextNode(child) || child.role === "text container")
				) {
					return undefined;
				}
				return pruneA11yTree(child, options);
			})
			.filter((child) => child !== undefined);
	}

	/**
	 * @param {AXNode[] | undefined} children
	 * @returns {AXNode[] | undefined}
	 */
	function makeStableChildren(children) {
		if (children === undefined) {
			return undefined;
		}
		return children.map(makeStableNode).filter((node) => node !== null);
	}
}

function isTextNode(node) {
	// chromium: text, firefox: text leaf
	return node != null && (node.role === "text" || node.role === "text leaf");
}

function isListMarker(node) {
	// chromium: ListMarker, firefox: list item marker
	return (
		node != null &&
		(node.role === "ListMarker" || node.role === "list item marker")
	);
}
