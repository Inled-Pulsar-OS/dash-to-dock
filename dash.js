// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    Gio,
    GLib,
    GObject,
    Shell,
    St,
} from './dependencies/gi.js';

import {
    AppFavorites,
    Dash,
    DND,
    Main,
} from './dependencies/shell/ui.js';

import {
    Config,
    Util,
} from './dependencies/shell/misc.js';

import {
    AppIcons,
    Docking,
    Theming,
    Utils,
} from './imports.js';

// module "Dash" did not export DASH_ANIMATION_TIME in old versions
// so we just define it like it is defined in Dash;
// taken from https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
const DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME ?? 200;
const DASH_VISIBILITY_TIMEOUT = 3;

const Labels = Object.freeze({
    SHOW_MOUNTS: Symbol('show-mounts'),
    FIRST_LAST_CHILD_WORKAROUND: Symbol('first-last-child-workaround'),
});

/**
 * Extend DashItemContainer
 *
 * - set label position based on dash orientation
 *
 */
const DockDashItemContainer = GObject.registerClass(
class DockDashItemContainer extends Dash.DashItemContainer {
    _init(position) {
        super._init({
            clip_to_allocation: false,
        });

        this.label?.add_style_class_name(Theming.PositionStyleClass[position]);
        if (Docking.DockManager.settings.customThemeShrink)
            this.label?.add_style_class_name('shrink');
    }

    showLabel() {
        return AppIcons.itemShowLabel.call(this);
    }

    // we override the method show taken from:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dash.js
    // in order to apply a little modification at the end of the animation
    // which makes sure that the icon background is not blurry
    show(animate) {
        if (this.child == null)
            return;

        this.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: animate ? DASH_ANIMATION_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // when the animation is ended, we simulate
                // a hover to gain back focus and unblur the
                // background
                this.set_hover(true);
            },
        });
    }
});

const DockDashIconsVerticalLayout = GObject.registerClass(
    class DockDashIconsVerticalLayout extends Clutter.BoxLayout {
        _init() {
            super._init({
                orientation: Clutter.Orientation.VERTICAL,
            });
        }

        vfunc_get_preferred_height(container, forWidth) {
            const [natHeight] = super.vfunc_get_preferred_height(container, forWidth);
            return [natHeight, 0];
        }
    });

const DockMinimizedWindowItem = GObject.registerClass(
class DockMinimizedWindowItem extends St.Button {
    _init(metaWindow, iconSize, isHorizontal) {
        super._init({
            style_class: 'app-well-app minimized-window-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this.metaWindow = metaWindow;
        this.iconSize = iconSize;
        this._isHorizontal = isHorizontal;

        const bin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: iconSize,
            height: iconSize,
        });

        this._previewBin = bin;
        this.set_child(bin);

        this._updateThumbnail();

        // Refresh thumbnail after layout completes in case window texture is ready later
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this.mapped)
                this._updateThumbnail();
            return GLib.SOURCE_REMOVE;
        });

        this.connect('clicked', () => {
            if (this.metaWindow) {
                Main.activateWindow(this.metaWindow);
            }
        });

        this._destroyId = this.metaWindow.connect('unmanaged', () => {
            this.destroy();
        });
    }

    _updateThumbnail() {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(this.metaWindow);

        const mutterWindow = this.metaWindow?.get_compositor_private();
        if (mutterWindow && mutterWindow.get_texture()) {
            const clone = new Clutter.Clone({
                source: mutterWindow,
                reactive: false,
            });
            const [w, h] = mutterWindow.get_size();
            if (w > 0 && h > 0) {
                const padding = 6;
                const availableSize = Math.max(16, this.iconSize - padding);
                const scale = Math.min(availableSize / w, availableSize / h);
                const cloneWidth = Math.max(16, Math.round(w * scale));
                const cloneHeight = Math.max(16, Math.round(h * scale));
                clone.set_size(cloneWidth, cloneHeight);

                const container = new St.Widget({
                    layout_manager: new Clutter.BinLayout(),
                    width: this.iconSize,
                    height: this.iconSize,
                });
                container.add_child(clone);

                // Small mini app icon emblem in the corner like macOS
                if (app) {
                    const emblemSize = Math.round(this.iconSize * 0.35);
                    const miniIcon = app.create_icon_texture(emblemSize);
                    miniIcon.set({
                        x_align: Clutter.ActorAlign.END,
                        y_align: Clutter.ActorAlign.END,
                    });
                    container.add_child(miniIcon);
                }

                this._previewBin.set_child(container);
                return;
            }
        }

        const icon = app ? app.create_icon_texture(this.iconSize) : new St.Icon({
            icon_name: 'window-new-symbolic',
            icon_size: this.iconSize,
        });
        this._previewBin.set_child(icon);
    }

    destroy() {
        if (this._destroyId && this.metaWindow) {
            try {
                this.metaWindow.disconnect(this._destroyId);
            } catch {}
            this._destroyId = 0;
        }
        super.destroy();
    }
});


const baseIconSizes = [16, 22, 24, 32, 48, 64, 96, 128];

/**
 * This class is a fork of the upstream dash class (ui.dash.js)
 *
 * Summary of changes:
 * - disconnect global signals adding a destroy method;
 * - play animations even when not in overview mode
 * - set a maximum icon size
 * - show running and/or favorite applications
 * - hide showApps label when the custom menu is shown.
 * - add scrollview
 *   ensure actor is visible on keyfocus inseid the scrollview
 * - add 128px icon size, might be useful for hidpi display
 * - sync minimization application target position.
 * - keep running apps ordered.
 */
export const DockDash = GObject.registerClass({
    Properties: {
        'requires-visibility': GObject.ParamSpec.boolean(
            'requires-visibility', 'requires-visibility', 'requires-visibility',
            GObject.ParamFlags.READWRITE,
            false),
        'max-width': GObject.ParamSpec.int(
            'max-width', 'max-width', 'max-width',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
        'max-height': GObject.ParamSpec.int(
            'max-height', 'max-height', 'max-height',
            GObject.ParamFlags.READWRITE,
            -1, GLib.MAXINT32, -1),
    },
    Signals: {
        'menu-opened': {},
        'menu-closed': {},
        'icon-size-changed': {},
    },
}, class DockDash extends St.Widget {
    _init(monitorIndex) {
        // Initialize icon variables and size
        super._init({
            name: 'dash',
            clip_to_allocation: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._maxWidth = -1;
        this._maxHeight = -1;
        this.iconSize = Docking.DockManager.settings.dashMaxIconSize;
        this._availableIconSizes = baseIconSizes;
        this._shownInitially = false;
        this._initializeIconSize(this.iconSize);
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        this._separator = null;

        this._monitorIndex = monitorIndex;
        this._position = Utils.getPosition();
        this._isHorizontal = (this._position === St.Side.TOP) ||
                               (this._position === St.Side.BOTTOM);

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._labelShowing = false;

        this._dashContainer = new St.BoxLayout({
            name: 'dashtodockDashContainer',
            clip_to_allocation: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            vertical: !this._isHorizontal,
            y_expand: this._isHorizontal,
            x_expand: !this._isHorizontal,
        });

        this._scrollView = new St.ScrollView({
            name: 'dashtodockDashScrollview',
            clip_to_allocation: false,
            hscrollbar_policy: this._isHorizontal ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
            vscrollbar_policy: this._isHorizontal ?  St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
            x_expand: this._isHorizontal,
            y_expand: !this._isHorizontal,
            enable_mouse_scrolling: false,
        });

        this._scrollView.connect('scroll-event', this._onScrollEvent.bind(this));

        this._boxContainer = new St.BoxLayout({
            name: 'dashtodockBoxContainer',
            clip_to_allocation: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            vertical: !this._isHorizontal,
            reactive: true,
        });
        this._boxContainer.add_style_class_name(Theming.PositionStyleClass[this._position]);

        this._boxContainer.connect('motion-event', (_actor, event) => {
            this._onDockMotionEvent(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this._boxContainer.connect('leave-event', () => {
            this._resetMagnification();
            return Clutter.EVENT_PROPAGATE;
        });

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        this._box = new St.BoxLayout({
            vertical: !this._isHorizontal,
            clip_to_allocation: false,
            ...!this._isHorizontal ? {layout_manager: new DockDashIconsVerticalLayout()} : {},
            x_align: rtl ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            y_align: this._isHorizontal ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            y_expand: !this._isHorizontal,
            x_expand: this._isHorizontal,
        });
        this._box._delegate = this;
        this._boxContainer.add_child(this._box);
        Utils.addActor(this._scrollView, this._boxContainer);
        this._dashContainer.add_child(this._scrollView);

        this._showAppsIcon = new AppIcons.DockShowAppsIcon(this._position);
        this._showAppsIcon.show(false);
        this._showAppsIcon.icon.setIconSize(this.iconSize);
        this._showAppsIcon.x_expand = false;
        this._showAppsIcon.y_expand = false;
        this.showAppsButton.connect('notify::hover', a => {
            if (this._showAppsIcon.get_parent() === this._boxContainer)
                this._ensureItemVisibility(a);
        });
        if (!this._isHorizontal)
            this._showAppsIcon.y_align = Clutter.ActorAlign.START;
        this._hookUpLabel(this._showAppsIcon);
        this._showAppsIcon.connect('menu-state-changed', (_icon, opened) => {
            this._itemMenuStateChanged(this._showAppsIcon, opened);
        });
        this.updateShowAppsButton();

        this._background = new St.Widget({
            style_class: 'dash-background',
            y_expand: this._isHorizontal,
            x_expand: !this._isHorizontal,
        });

        const sizerBox = new Clutter.Actor();
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._showAppsIcon.icon : this._dashContainer,
            coordinate: Clutter.BindCoordinate.HEIGHT,
        }));
        sizerBox.add_constraint(new Clutter.BindConstraint({
            source: this._isHorizontal ? this._dashContainer : this._showAppsIcon.icon,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        this._background.add_child(sizerBox);

        this.add_child(this._background);
        this.add_child(this._dashContainer);

        this._workId = Main.initializeDeferredWork(this._box, this._redisplay.bind(this));

        this._shellSettings = new Gio.Settings({
            schema_id: 'org.gnome.shell',
        });

        this._appSystem = Shell.AppSystem.get_default();

        this.iconAnimator = new Docking.IconAnimator(this);

        this._signalsHandler.add([
            this._appSystem,
            'installed-changed',
            () => {
                AppFavorites.getAppFavorites().reload();
                this._queueRedisplay();
            },
        ], [
            AppFavorites.getAppFavorites(),
            'changed',
            this._queueRedisplay.bind(this),
        ], [
            this._appSystem,
            'app-state-changed',
            this._queueRedisplay.bind(this),
        ], [
            global.display,
            'window-created',
            (_display, window) => {
                window.connectObject('notify::minimized', () => this._queueRedisplay(), this);
                this._queueRedisplay();
            },
        ], [
            global.display,
            'restacked',
            () => this._queueRedisplay(),
        ], [
            global.window_manager,
            'minimize',
            () => this._queueRedisplay(),
        ], [
            global.window_manager,
            'unminimize',
            () => this._queueRedisplay(),
        ], [
            global.workspace_manager,
            'workspace-switched',
            () => this._queueRedisplay(),
        ], [
            Main.overview,
            'item-drag-begin',
            this._onItemDragBegin.bind(this),
        ], [
            Main.overview,
            'item-drag-end',
            this._onItemDragEnd.bind(this),
        ], [
            Main.overview,
            'item-drag-cancelled',
            this._onItemDragCancelled.bind(this),
        ], [
            Main.overview,
            'window-drag-begin',
            this._onWindowDragBegin.bind(this),
        ], [
            Main.overview,
            'window-drag-cancelled',
            this._onWindowDragEnd.bind(this),
        ], [
            Main.overview,
            'window-drag-end',
            this._onWindowDragEnd.bind(this),
        ]);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_get_preferred_height(forWidth) {
        const [minHeight, natHeight] = super.vfunc_get_preferred_height.call(this, forWidth);
        if (!this._isHorizontal && this._maxHeight !== -1 && natHeight > this._maxHeight)
            return [minHeight, this._maxHeight];
        else
            return [minHeight, natHeight];
    }

    vfunc_get_preferred_width(forHeight) {
        const [minWidth, natWidth] = super.vfunc_get_preferred_width.call(this, forHeight);
        if (this._isHorizontal && this._maxWidth !== -1 && natWidth > this._maxWidth)
            return [minWidth, this._maxWidth];
        else
            return [minWidth, natWidth];
    }

    get _container() {
        return this._dashContainer;
    }

    _onDestroy() {
        this.iconAnimator.destroy();

        if (this._requiresVisibilityTimeout) {
            GLib.source_remove(this._requiresVisibilityTimeout);
            delete this._requiresVisibilityTimeout;
        }

        if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            delete this._ensureActorVisibilityTimeoutId;
        }
    }


    _onItemDragBegin(...args) {
        return Dash.Dash.prototype._onItemDragBegin.call(this, ...args);
    }

    _onItemDragCancelled(...args) {
        return Dash.Dash.prototype._onItemDragCancelled.call(this, ...args);
    }

    _onItemDragEnd(...args) {
        return Dash.Dash.prototype._onItemDragEnd.call(this, ...args);
    }

    _endItemDrag(...args) {
        return Dash.Dash.prototype._endItemDrag.call(this, ...args);
    }

    _onItemDragMotion(...args) {
        return Dash.Dash.prototype._onItemDragMotion.call(this, ...args);
    }

    _appIdListToHash(...args) {
        return Dash.Dash.prototype._appIdListToHash.call(this, ...args);
    }

    _queueRedisplay(...args) {
        return Dash.Dash.prototype._queueRedisplay.call(this, ...args);
    }

    _hookUpLabel(...args) {
        return Dash.Dash.prototype._hookUpLabel.call(this, ...args);
    }

    _syncLabel(...args) {
        return Dash.Dash.prototype._syncLabel.call(this, ...args);
    }

    _clearDragPlaceholder(...args) {
        return Dash.Dash.prototype._clearDragPlaceholder.call(this, ...args);
    }

    _clearEmptyDropTarget(...args) {
        return Dash.Dash.prototype._clearEmptyDropTarget.call(this, ...args);
    }

    handleDragOver(source, actor, x, y, time) {
        let ret;
        if (this._isHorizontal) {
            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, x, y, time);

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;
        } else {
            const propertyInjections = new Utils.PropertyInjectionsHandler();
            propertyInjections.add(this._box, 'width', {
                get: () => this._box.get_children().reduce((a, c) => a + c.height, 0),
            });

            if (this._dragPlaceholder) {
                propertyInjections.add(this._dragPlaceholder, 'width', {
                    get: () => this._dragPlaceholder.height,
                });
            }

            ret = Dash.Dash.prototype.handleDragOver.call(this, source, actor, y, x, time);
            propertyInjections.destroy();

            if (ret === DND.DragMotionResult.CONTINUE)
                return ret;

            if (this._dragPlaceholder) {
                this._dragPlaceholder.child.set_width(this.iconSize / 2);
                this._dragPlaceholder.child.set_height(this.iconSize);

                let pos = this._dragPlaceholderPos;
                if (this._isHorizontal &&
                    Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
                    pos = this._box.get_children() - 1 - pos;

                if (pos !== this._dragPlaceholderPos) {
                    this._dragPlaceholderPos = pos;
                    this._box.set_child_at_index(this._dragPlaceholder,
                        this._dragPlaceholderPos);
                }
            }
        }

        if (this._dragPlaceholder) {
            // Ensure the next and previous icon are visible when moving the
            // placeholder (we're assuming there's room for both of them)
            const children = this._box.get_children();
            if (this._dragPlaceholderPos > 0) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos - 1]);
            }

            if (this._dragPlaceholderPos >= -1 &&
                this._dragPlaceholderPos < children.length - 1) {
                ensureActorVisibleInScrollView(this._scrollView,
                    children[this._dragPlaceholderPos + 1]);
            }
        }

        return ret;
    }

    acceptDrop(...args) {
        return Dash.Dash.prototype.acceptDrop.call(this, ...args);
    }

    _onWindowDragBegin(...args) {
        return Dash.Dash.prototype._onWindowDragBegin.call(this, ...args);
    }

    _onWindowDragEnd(...args) {
        return Dash.Dash.prototype._onWindowDragEnd.call(this, ...args);
    }

    _onScrollEvent(actor, event) {
        // reset timeout to avoid conflicts with the mousehover event
        this._ensureItemVisibility(null);

        let adjustment, delta = 0;

        if (this._isHorizontal) {
            adjustment = this._scrollView.get_hadjustment
                ? this._scrollView.get_hadjustment()
                : this._scrollView.get_hscroll_bar()?.get_adjustment();
        } else {
            adjustment = this._scrollView.get_vadjustment
                ? this._scrollView.get_vadjustment()
                : this._scrollView.get_vscroll_bar()?.get_adjustment();
        }

        if (!adjustment)
            return Clutter.EVENT_PROPAGATE;

        const increment = adjustment.step_increment || 30;
        let dx = 0, dy = 0;

        if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
            [dx, dy] = event.get_scroll_delta();
        } else if (event.get_scroll_direction() === Clutter.ScrollDirection.UP) {
            dy = -1;
        } else if (event.get_scroll_direction() === Clutter.ScrollDirection.DOWN) {
            dy = 1;
        }

        if (this._isHorizontal)
            delta = (Math.abs(dx) > Math.abs(dy) ? dx : dy) * increment;
        else
            delta = dy * increment;

        if (delta === 0)
            return Clutter.EVENT_PROPAGATE;

        const value = adjustment.get_value();
        const lower = adjustment.get_lower();
        const upper = adjustment.get_upper() - adjustment.get_page_size();

        const newValue = Math.min(Math.max(value + delta, lower), Math.max(lower, upper));
        adjustment.set_value(newValue);

        return Clutter.EVENT_STOP;
    }

    _ensureItemVisibility(actor) {
        if (actor?.hover) {
            const destroyId =
                actor.connect('destroy', () => this._ensureItemVisibility(null));
            this._ensureActorVisibilityTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 100, () => {
                    actor.disconnect(destroyId);
                    ensureActorVisibleInScrollView(this._scrollView, actor);
                    this._ensureActorVisibilityTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                });
        } else if (this._ensureActorVisibilityTimeoutId) {
            GLib.source_remove(this._ensureActorVisibilityTimeoutId);
            this._ensureActorVisibilityTimeoutId = 0;
        }
    }

    _createAppItem(app) {
        const appIcon = new AppIcons.makeAppIcon(app, this._monitorIndex, this.iconAnimator);

        if (appIcon._draggable) {
            appIcon._draggable.connect('drag-begin', () => {
                appIcon.opacity = 50;
            });
            appIcon._draggable.connect('drag-end', () => {
                appIcon.opacity = 255;
            });
        }

        appIcon.connectObject('menu-state-changed', (_, opened) => {
            this._itemMenuStateChanged(item, opened);
        }, this);

        const item = new DockDashItemContainer(this._position);
        item.setChild(appIcon);

        appIcon.connectObject('notify::hover', a => this._ensureItemVisibility(a), this);
        appIcon.connectObject('clicked', actor => {
            ensureActorVisibleInScrollView(this._scrollView, actor);
        }, this);

        appIcon.connectObject('key-focus-in', actor => {
            const [xShift, yShift] = ensureActorVisibleInScrollView(this._scrollView, actor);

            // This signal is triggered also by mouse click. The popup menu is opened at the original
            // coordinates. Thus correct for the shift which is going to be applied to the scrollview.
            if (appIcon._menu) {
                appIcon._menu._boxPointer.xOffset = -xShift;
                appIcon._menu._boxPointer.yOffset = -yShift;
            }
        }, this);

        appIcon.connectObject('notify::focused', () => {
            const {settings} = Docking.DockManager;
            if (appIcon.focused && settings.scrollToFocusedApplication)
                ensureActorVisibleInScrollView(this._scrollView, item);
        }, this);

        appIcon.connectObject('notify::urgent', () => {
            if (appIcon.urgent) {
                ensureActorVisibleInScrollView(this._scrollView, item);
                if (Docking.DockManager.settings.showDockUrgentNotify)
                    this._requireVisibility();
            }
        }, this);

        // Override default AppIcon label_actor, now the
        // accessible_name is set at DashItemContainer.setLabelText
        appIcon.label_actor = null;
        item.setLabelText(app.get_name());

        appIcon.icon.setIconSize(this.iconSize);
        this._hookUpLabel(item, appIcon);

        item.connectObject('notify::position', () => appIcon.updateIconGeometry(), appIcon);
        item.connectObject('notify::size', () => appIcon.updateIconGeometry(), appIcon);

        return item;
    }

    _onDockMotionEvent(event) {
        if (!Docking.DockManager.settings.dockMagnification) {
            this._resetMagnification();
            return;
        }

        const [pointerX, pointerY] = event.get_coords();
        const maxFactor = Docking.DockManager.settings.magnificationSizeFactor || 1.6;
        const appIcons = this.getAppIcons();

        // Effective distance of magnification influence in px
        const spreadRadius = (this.iconSize || 48) * 2.5;

        // First pass: compute target scale and vertical lift for each icon
        const iconData = [];
        appIcons.forEach((icon, idx) => {
            if (!icon.mapped) {
                iconData.push({icon, scale: 1.0, transX: 0, transY: 0, spreadOffset: 0});
                return;
            }

            const [x, y] = icon.get_transformed_position();
            const [w, h] = icon.get_transformed_size();
            const centerX = x + w / 2;
            const centerY = y + h / 2;

            const distance = this._isHorizontal
                ? Math.abs(pointerX - centerX)
                : Math.abs(pointerY - centerY);

            let scale = 1.0;
            let transY = 0;
            let transX = 0;

            if (distance < spreadRadius) {
                // Smooth cosine curve
                const factor = (1 + Math.cos((Math.PI * distance) / spreadRadius)) / 2;
                scale = 1.0 + (maxFactor - 1.0) * factor;

                // Rise towards the outer edge
                const lift = ((scale - 1.0) * (this.iconSize || 48)) * 0.7;
                if (this._position === St.Side.BOTTOM) {
                    transY = -lift;
                } else if (this._position === St.Side.TOP) {
                    transY = lift;
                } else if (this._position === St.Side.LEFT) {
                    transX = lift;
                } else if (this._position === St.Side.RIGHT) {
                    transX = -lift;
                }
            }

            iconData.push({icon, scale, transX, transY, spreadOffset: 0, idx, centerX, centerY});
        });

        // Second pass: lateral displacement (push neighbours away like dash2dock-lite & macOS)
        for (let i = 0; i < iconData.length; i++) {
            const data = iconData[i];
            if (data.scale > 1.05) {
                const extraWidth = (data.scale - 1.0) * (this.iconSize || 48) * 0.5;
                for (let j = 0; j < i; j++)
                    iconData[j].spreadOffset -= extraWidth * (1 / (i - j + 1));
                for (let j = i + 1; j < iconData.length; j++)
                    iconData[j].spreadOffset += extraWidth * (1 / (j - i + 1));
            }
        }

        // Apply scales and translations
        iconData.forEach(data => {
            const targetActor = data.icon.get_parent() instanceof DockDashItemContainer
                ? data.icon.get_parent()
                : (data.icon.icon?._iconBin ?? data.icon.icon ?? data.icon._previewBin ?? data.icon);
            if (!targetActor)
                return;

            let finalTransX = data.transX;
            let finalTransY = data.transY;

            if (this._isHorizontal)
                finalTransX += data.spreadOffset;
            else
                finalTransY += data.spreadOffset;

            targetActor.set_pivot_point(0.5, 0.5);
            targetActor.ease({
                scale_x: data.scale,
                scale_y: data.scale,
                translation_x: finalTransX,
                translation_y: finalTransY,
                duration: 60,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _resetMagnification() {
        const appIcons = this.getAppIcons();
        appIcons.forEach(icon => {
            const targetActor = icon.get_parent() instanceof DockDashItemContainer
                ? icon.get_parent()
                : (icon.icon?._iconBin ?? icon.icon ?? icon._previewBin ?? icon);
            if (targetActor) {
                targetActor.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    translation_x: 0,
                    translation_y: 0,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        });
    }

    /**
     * Return an array with all interactive icons currently in the dash
     */
    getAppIcons() {
        const result = [];
        const children = this._box.get_children();
        children.forEach(actor => {
            if (actor.animatingOut)
                return;
            if (actor.child && actor.child.icon) {
                result.push(actor.child);
            } else if (actor instanceof DockMinimizedWindowItem) {
                result.push(actor);
            }
        });

        if (this._showAppsIcon && this._showAppsIcon.visible) {
            result.push(this._showAppsIcon);
        }

        return result;
    }

    _itemMenuStateChanged(item, opened) {
        Dash.Dash.prototype._itemMenuStateChanged.call(this, item, opened);

        if (opened) {
            this.emit('menu-opened');
        } else {
            // I want to listen from outside when a menu is closed. I used to
            // add a custom signal to the appIcon, since gnome 3.8 the signal
            // calling this callback was added upstream.
            this.emit('menu-closed');
        }
    }

    _adjustIconSize() {
        // For the icon size, we only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        const iconChildren = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.icon &&
                   !actor.animatingOut;
        });

        iconChildren.push(this._showAppsIcon);

        if (this._maxWidth === -1 && this._maxHeight === -1)
            return;

        // Check if the container is present in the stage. This avoids critical
        // errors when unlocking the screen
        if (!this._container.get_stage())
            return;

        const themeNode = this._dashContainer.get_theme_node();
        const maxAllocation = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: this._isHorizontal ? this._maxWidth : 42 /* whatever */,
            y2: this._isHorizontal ? 42 : this._maxHeight,
        });
        const maxContent = themeNode.get_content_box(maxAllocation);
        let availSpace;
        if (this._isHorizontal)
            availSpace = maxContent.get_width();
        else
            availSpace = maxContent.get_height();

        const spacing = themeNode.get_length('spacing');

        const [{child: firstButton}] = iconChildren;
        const {child: firstIcon} = firstButton?.icon ?? {child: null};

        // if no icons there's nothing to adjust
        if (!firstIcon)
            return;

        // Enforce valid spacings during the size request
        firstIcon.ensure_style();
        const [, , iconWidth, iconHeight] = firstIcon.get_preferred_size();
        const [, , buttonWidth, buttonHeight] = firstButton.get_preferred_size();

        if (this._isHorizontal) {
            // Subtract icon padding and box spacing from the available width
            availSpace -= iconChildren.length * (buttonWidth - iconWidth) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , separatorWidth] = this._separator.get_preferred_size();
                availSpace -= separatorWidth + spacing;
            }
        } else {
            // Subtract icon padding and box spacing from the available height
            availSpace -= iconChildren.length * (buttonHeight - iconHeight) +
                           (iconChildren.length - 1) * spacing;

            if (this._separator) {
                const [, , , separatorHeight] = this._separator.get_preferred_size();
                availSpace -= separatorHeight + spacing;
            }
        }

        const maxIconSize = availSpace / iconChildren.length;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const iconSizes = this._availableIconSizes.map(s => s * scaleFactor);

        let [newIconSize] = this._availableIconSizes;
        for (let i = 0; i < iconSizes.length; i++) {
            if (iconSizes[i] <= maxIconSize)
                newIconSize = this._availableIconSizes[i];
        }

        if (newIconSize === this.iconSize)
            return;

        const oldIconSize = this.iconSize;
        this.iconSize = newIconSize;
        this.emit('icon-size-changed');

        const scale = oldIconSize / newIconSize;
        for (let i = 0; i < iconChildren.length; i++) {
            const {icon} = iconChildren[i].child._delegate;

            // Set the new size immediately, to keep the icons' sizes
            // in sync with this.iconSize
            icon.setIconSize(this.iconSize);

            // Don't animate the icon size change when the overview
            // is transitioning, not visible or when initially filling
            // the dash
            if (!Main.overview.visible || Main.overview.animationInProgress ||
                !this._shownInitially)
                continue;

            const [targetWidth, targetHeight] = icon.icon.get_size();

            // Scale the icon's texture to the previous size and
            // tween to the new size
            icon.icon.set_size(icon.icon.width * scale,
                icon.icon.height * scale);

            icon.icon.ease({
                width: targetWidth,
                height: targetHeight,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        if (this._separator) {
            const animateProperties = this._isHorizontal
                ? {height: this.iconSize} : {width: this.iconSize};

            this._separator.ease({
                ...animateProperties,
                duration: DASH_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _redisplay() {
        const favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let running = this._appSystem.get_running();
        const dockManager = Docking.DockManager.getDefault();
        const {settings} = dockManager;

        this._scrollView.set({
            xAlign: Clutter.ActorAlign.FILL,
            yAlign: Clutter.ActorAlign.FILL,
        });
        if (dockManager.settings.dockExtended) {
            if (!this._isHorizontal) {
                this._scrollView.yAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            } else {
                this._scrollView.xAlign = dockManager.settings.alwaysCenterIcons
                    ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            }
        }

        if (settings.isolateWorkspaces ||
            settings.isolateMonitors) {
            // When using isolation, we filter out apps that have no windows in
            // the current workspace
            const monitorIndex = this._monitorIndex;
            running = running.filter(app =>
                AppIcons.getInterestingWindows(app.get_windows(), monitorIndex).length);
        }

        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   actor.child._delegate &&
                   actor.child._delegate.app;
        });
        // Apps currently in the dash
        let oldApps = children.map(actor => actor.child._delegate.app);
        // Apps supposed to be in the dash
        const newApps = [];

        const {showFavorites} = settings;
        if (showFavorites)
            newApps.push(...Object.values(favorites));

        if (settings.showRunning) {
            // We reorder the running apps so that they don't change position on the
            // dash with every redisplay() call

            // First: add the apps from the oldApps list that are still running
            oldApps.forEach(oldApp => {
                const index = running.indexOf(oldApp);
                if (index > -1) {
                    const [app] = running.splice(index, 1);
                    if (!showFavorites || !(app.get_id() in favorites))
                        newApps.push(app);
                }
            });

            // Second: add the new apps
            running.forEach(app => {
                if (!showFavorites || !(app.get_id() in favorites))
                    newApps.push(app);
            });
        }

        this._signalsHandler.removeWithLabel(Labels.SHOW_MOUNTS);
        if (dockManager.removables) {
            this._signalsHandler.addWithLabel(Labels.SHOW_MOUNTS,
                dockManager.removables, 'changed', this._queueRedisplay.bind(this));
            dockManager.removables.getApps().forEach(removable => {
                if (!newApps.includes(removable))
                    newApps.push(removable);
            });
        } else {
            oldApps = oldApps.filter(app => !app.location || app.isTrash || app.isDownloads);
        }

        if (dockManager.downloads) {
            const downloadsApp = dockManager.downloads.getApp();
            if (!newApps.includes(downloadsApp))
                newApps.push(downloadsApp);
        } else {
            oldApps = oldApps.filter(app => !app.isDownloads);
        }

        if (dockManager.trash) {
            const trashApp = dockManager.trash.getApp();
            if (!newApps.includes(trashApp))
                newApps.push(trashApp);
        } else {
            oldApps = oldApps.filter(app => !app.isTrash);
        }

        // Temporary remove the separator so that we don't compute to position icons
        const oldSeparatorPos = this._box.get_children().indexOf(this._separator);
        if (this._separator)
            this._box.remove_child(this._separator);

        // Figure out the actual changes to the list of items; we iterate
        // over both the list of items currently in the dash and the list
        // of items expected there, and collect additions and removals.
        // Moves are both an addition and a removal, where the order of
        // the operations depends on whether we encounter the position
        // where the item has been added first or the one from where it
        // was removed.
        // There is an assumption that only one item is moved at a given
        // time; when moving several items at once, everything will still
        // end up at the right position, but there might be additional
        // additions/removals (e.g. it might remove all the launchers
        // and add them back in the new order even if a smaller set of
        // additions and removals is possible).
        // If above assumptions turns out to be a problem, we might need
        // to use a more sophisticated algorithm, e.g. Longest Common
        // Subsequence as used by diff.

        const addedItems = [];
        const removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;
        while (newIndex < newApps.length || oldIndex < oldApps.length) {
            const oldApp = oldApps.length > oldIndex ? oldApps[oldIndex] : null;
            const newApp = newApps.length > newIndex ? newApps[newIndex] : null;

            // No change at oldIndex/newIndex
            if (oldApp === newApp) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // App removed at oldIndex
            if (oldApp && !newApps.includes(oldApp)) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // App added at newIndex
            if (newApp && !oldApps.includes(newApp)) {
                addedItems.push({
                    app: newApp,
                    item: this._createAppItem(newApp),
                    pos: newIndex,
                });
                newIndex++;
                continue;
            }

            // App moved
            const nextApp = newApps.length > newIndex + 1
                ? newApps[newIndex + 1] : null;
            const insertHere = nextApp && nextApp === oldApp;
            const alreadyRemoved = removedActors.reduce((result, actor) => {
                const removedApp = actor.child._delegate.app;
                return result || removedApp === newApp;
            }, false);

            if (insertHere || alreadyRemoved) {
                const newItem = this._createAppItem(newApp);
                addedItems.push({
                    app: newApp,
                    item: newItem,
                    pos: newIndex + removedActors.length,
                });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++) {
            this._box.insert_child_at_index(addedItems[i].item,
                addedItems[i].pos);
        }

        for (let i = 0; i < removedActors.length; i++) {
            const item = removedActors[i];

            // Don't animate item removal when the overview is transitioning
            // or hidden
            if (!Main.overview.animationInProgress)
                item.animateOutAndDestroy();
            else
                item.destroy();
        }

        // Update separator
        const nFavorites = Object.keys(favorites).length;
        const nIcons = children.length + addedItems.length - removedActors.length;
        if (nFavorites > 0 && nFavorites < nIcons) {
            if (!this._separator) {
                this._separator = new St.Widget({
                    style_class: 'dash-separator',
                    x_align: this._isHorizontal
                        ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                    y_align: this._isHorizontal
                        ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    width: this._isHorizontal ? -1 : this.iconSize,
                    height: this._isHorizontal ? this.iconSize : -1,
                    reactive: true,
                    track_hover: true,
                });
                this._separator.connect('notify::hover', a => this._ensureItemVisibility(a));
            }
            let pos = nFavorites + this._animatingPlaceholdersCount;
            if (this._dragPlaceholder)
                pos++;
            const removedFavorites = removedActors.filter(a =>
                children.indexOf(a) < oldSeparatorPos);
            pos += removedFavorites.length;
            this._box.insert_child_at_index(this._separator, pos);
        } else if (this._separator) {
            this._separator.destroy();
            this._separator = null;
        }

        this._adjustIconSize();

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once
        const animate = this._shownInitially &&
            !Main.layoutManager._startingUp;

        if (!this._shownInitially)
            this._shownInitially = true;

        addedItems.forEach(({item}) => item.show(animate));

        // Workaround for https://bugzilla.gnome.org/show_bug.cgi?id=692744
        // Without it, StBoxLayout may use a stale size cache
        this._box.queue_relayout();

        // This will update the size, and the corresponding number for each icon
        this._updateNumberOverlay();

        // Update Minimized Windows Section
        if (this._minimizedSeparator) {
            this._box.remove_child(this._minimizedSeparator);
            this._minimizedSeparator.destroy();
            this._minimizedSeparator = null;
        }
        if (this._minimizedWindowItems) {
            this._minimizedWindowItems.forEach(item => {
                this._box.remove_child(item);
                item.destroy();
            });
            this._minimizedWindowItems = [];
        }

        if (Docking.DockManager.settings.showMinimizedWindows) {
            const currentWorkspace = global.workspace_manager.get_active_workspace();
            const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, currentWorkspace);
            const minimizedWindows = allWindows.filter(w => w.minimized && !w.skip_taskbar);

            if (minimizedWindows.length > 0) {
                this._minimizedSeparator = new St.Widget({
                    style_class: 'dash-separator',
                    x_align: this._isHorizontal
                        ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                    y_align: this._isHorizontal
                        ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
                    width: this._isHorizontal ? -1 : this.iconSize,
                    height: this._isHorizontal ? this.iconSize : -1,
                    reactive: true,
                    track_hover: true,
                });
                this._box.add_child(this._minimizedSeparator);

                this._minimizedWindowItems = [];
                minimizedWindows.forEach(win => {
                    const item = new DockMinimizedWindowItem(win, this.iconSize, this._isHorizontal);
                    this._box.add_child(item);
                    this._minimizedWindowItems.push(item);
                });
            }
        }

        this.updateShowAppsButton();
    }

    _updateNumberOverlay() {
        const appIcons = this.getAppIcons();
        let counter = 1;
        appIcons.forEach(icon => {
            if (counter < 10) {
                icon.setNumberOverlay(counter);
                counter++;
            } else if (counter === 10) {
                icon.setNumberOverlay(0);
                counter++;
            } else {
                // No overlay after 10
                icon.setNumberOverlay(-1);
            }
            icon.updateNumberOverlay();
        });
    }

    toggleNumberOverlay(activate) {
        const appIcons = this.getAppIcons();
        appIcons.forEach(icon => {
            icon.toggleNumberOverlay(activate);
        });
    }

    _initializeIconSize(maxSize) {
        const maxAllowed = baseIconSizes[baseIconSizes.length - 1];
        maxSize = Math.min(maxSize, maxAllowed);

        if (Docking.DockManager.settings.iconSizeFixed) {
            this._availableIconSizes = [maxSize];
        } else {
            this._availableIconSizes = baseIconSizes.filter(val => {
                return val < maxSize;
            });
            this._availableIconSizes.push(maxSize);
        }
    }

    setIconSize(maxSize, doNotAnimate) {
        this._initializeIconSize(maxSize);

        if (doNotAnimate)
            this._shownInitially = false;

        this._queueRedisplay();
    }

    /**
     * Reset the displayed apps icon to maintain the correct order when changing
     * show favorites/show running settings
     */
    resetAppIcons() {
        const children = this._box.get_children().filter(actor => {
            return actor.child &&
                   !!actor.child.icon;
        });
        for (let i = 0; i < children.length; i++) {
            const item = children[i];
            item.destroy();
        }

        // to avoid ugly animations, just suppress them like when dash is first loaded.
        this._shownInitially = false;
        this._redisplay();
    }

    get showAppsButton() {
        return this._showAppsIcon.toggleButton;
    }

    showShowAppsButton() {
        this._showAppsIcon.visible = true;
        this._showAppsIcon.show(true);
        this.updateShowAppsButton();
    }

    hideShowAppsButton() {
        this._showAppsIcon.visible = false;
    }

    get maxWidth() {
        return this._maxWidth;
    }

    get maxHeight() {
        return this._maxHeight;
    }

    set maxWidth(maxWidth) {
        this.setMaxSize(maxWidth, this._maxHeight);
    }

    set maxHeight(maxHeight) {
        this.setMaxSize(this._maxWidth, maxHeight);
    }

    setMaxSize(maxWidth, maxHeight) {
        if (this._maxWidth === maxWidth &&
            this._maxHeight === maxHeight)
            return;

        this._maxWidth = maxWidth;
        this._maxHeight = maxHeight;
        this._queueRedisplay();
    }

    updateShowAppsButton() {
        if (this._showAppsIcon.get_parent() && !this._showAppsIcon.visible)
            return;

        const {settings} = Docking.DockManager;
        const notifiedProperties = [];
        const showAppsContainer = settings.showAppsAlwaysInTheEdge || !settings.dockExtended
            ? this._dashContainer : this._boxContainer;
        const needsFirstLastChildWorkaround = Config.PACKAGE_VERSION.split('.')[0] < 49;

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.addWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND,
                showAppsContainer, 'notify',
                (_obj, pspec) => notifiedProperties.push(pspec.name));
        }

        if (this._showAppsIcon.get_parent() !== showAppsContainer) {
            this._showAppsIcon.get_parent()?.remove_child(this._showAppsIcon);

            if (Docking.DockManager.settings.showAppsAtTop)
                showAppsContainer.insert_child_below(this._showAppsIcon, null);
            else
                showAppsContainer.insert_child_above(this._showAppsIcon, null);
        } else if (settings.showAppsAtTop) {
            showAppsContainer.set_child_below_sibling(this._showAppsIcon, null);
        } else {
            showAppsContainer.set_child_above_sibling(this._showAppsIcon, null);
        }

        if (needsFirstLastChildWorkaround) {
            this._signalsHandler.removeWithLabel(Labels.FIRST_LAST_CHILD_WORKAROUND);

            // This is indeed ugly, but we need to ensure that the last and first
            // visible widgets are re-computed by St, that is buggy because of a
            // mutter issue that is being fixed:
            // https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/2047
            if (!notifiedProperties.includes('first-child'))
                showAppsContainer.notify('first-child');
            if (!notifiedProperties.includes('last-child'))
                showAppsContainer.notify('last-child');
        }
    }
});


/**
 * This is a copy of the same function in utils.js, but also adjust horizontal scrolling
 * and perform few further checks on the current value to avoid changing the values when
 * it would be clamp to the current one in any case.
 * Return the amount of shift applied
 *
 * @param scrollView
 * @param actor
 */
function ensureActorVisibleInScrollView(scrollView, actor) {
    // access to scrollView.[hv]scroll was deprecated in gnome 46
    // instead, adjustment can be accessed directly
    // keep old way for backwards compatibility (gnome <= 45)
    const vAdjustment = scrollView.vadjustment ?? scrollView.vscroll.adjustment;
    const hAdjustment = scrollView.hadjustment ?? scrollView.hscroll.adjustment;
    const {value: vValue0, pageSize: vPageSize, upper: vUpper} = vAdjustment;
    const {value: hValue0, pageSize: hPageSize, upper: hUpper} = hAdjustment;
    let [hValue, vValue] = [hValue0, vValue0];
    let vOffset = 0;
    let hOffset = 0;

    const fade = scrollView.get_effect('fade');
    if (fade) {
        vOffset = fade.fade_margins.top;
        hOffset = fade.fade_margins.left;
    }

    const box = actor.get_allocation_box();
    let {y1} = box, {y2} = box, {x1} = box, {x2} = box;

    let parent = actor.get_parent();
    while (parent !== scrollView) {
        if (!parent)
            throw new Error('Actor not in scroll view');

        const parentBox = parent.get_allocation_box();
        y1 += parentBox.y1;
        y2 += parentBox.y1;
        x1 += parentBox.x1;
        x2 += parentBox.x1;
        parent = parent.get_parent();
    }

    if (y1 < vValue + vOffset)
        vValue = Math.max(0, y1 - vOffset);
    else if (vValue < vUpper - vPageSize && y2 > vValue + vPageSize - vOffset)
        vValue = Math.min(vUpper - vPageSize, y2 + vOffset - vPageSize);

    if (x1 < hValue + hOffset)
        hValue = Math.max(0, x1 - hOffset);
    else if (hValue < hUpper - hPageSize && x2 > hValue + hPageSize - hOffset)
        hValue = Math.min(hUpper - hPageSize, x2 + hOffset - hPageSize);

    if (vValue !== vValue0) {
        vAdjustment.ease(vValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    if (hValue !== hValue0) {
        hAdjustment.ease(hValue, {
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            duration: Util.SCROLL_TIME,
        });
    }

    return [hValue - hValue0, vValue - vValue0];
}
