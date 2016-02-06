const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Tp = imports.gi.TelepathyGLib;

const AccountsMonitor = imports.accountsMonitor;
const AppNotifications = imports.appNotifications;
const ChatroomManager = imports.chatroomManager;
const JoinDialog = imports.joinDialog;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const MessageDialog = imports.messageDialog;
const RoomList = imports.roomList;
const RoomStack = imports.roomStack;
const UserList = imports.userList;
const Utils = imports.utils;

const CONFIGURE_TIMEOUT = 100; /* ms */


const FixedSizeFrame = new Lang.Class({
    Name: 'FixedSizeFrame',
    Extends: Gtk.Frame,
    Properties: {
        height: GObject.ParamSpec.int('height',
                                      'height',
                                      'height',
                                      GObject.ParamFlags.READWRITE,
                                      -1, GLib.MAXINT32, -1),
        width: GObject.ParamSpec.int('width',
                                     'width',
                                     'width',
                                     GObject.ParamFlags.READWRITE,
                                     -1, GLib.MAXINT32, -1)
    },

    _init: function(params) {
        this._height = -1;
        this._width = -1;

        this.parent(params);
    },

    _queueRedraw: function() {
        let child = this.get_child();
        if (child)
            child.queue_resize();
        this.queue_draw();
    },

    get height() {
        return this._height;
    },

    set height(height) {
        if (height == this._height)
            return;
        this._height = height;
        this.notify('height');
        this._queueRedraw();
    },

    get width() {
        return this._width;
    },

    set width(width) {
        if (width == this._width)
            return;

        this._width = width;
        this.notify('width');
        this._queueRedraw();
    },

    vfunc_get_preferred_width_for_height: function(forHeight) {
        if (this._width < 0)
            return this.parent(forHeight);
        else
            return [this._width, this._width];
    },

    vfunc_get_preferred_height_for_width: function(forWidth) {
        if (this._height < 0)
            return this.parent(forWidth);
        else
            return [this._height, this._height];
    }
});

const MainWindow = new Lang.Class({
    Name: 'MainWindow',

    _init: function(app) {
        this._rooms = {};
        this._entries = {};

        this._room = null;
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.Polari' });
        this._gtkSettings = Gtk.Settings.get_default();

        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._currentSize = [-1, -1];
        this._isMaximized = false;
        this._isFullscreen = false;

        this._createWidget(app);

        let provider = new Gtk.CssProvider();
        let uri = 'resource:///org/gnome/Polari/css/application.css';
        let file = Gio.File.new_for_uri(uri);
        try {
            provider.load_from_file(Gio.File.new_for_uri(uri));
        } catch(e) {
            logError(e, "Failed to add application style");
        }
        Gtk.StyleContext.add_provider_for_screen(
            this.window.get_screen(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        this._accountsMonitor = AccountsMonitor.getDefault();
        this._accountsMonitor.connect('accounts-changed', Lang.bind(this,
            function(am) {
                let accounts = am.dupAccounts();
                this._revealer.reveal_child = accounts.some(function(a) {
                    return a.enabled;
                });
            }));

        this._roomManager = ChatroomManager.getDefault();
        this._roomManager.connect('active-changed',
                                  Lang.bind(this, this._activeRoomChanged));
        this._roomManager.connect('active-state-changed',
                                  Lang.bind(this, this._updateUserListLabel));

        this._updateUserListLabel();

        this._userListAction = app.lookup_action('user-list');

        app.connect('action-state-changed::user-list', Lang.bind(this,
            function(group, actionName, value) {
                this._userListPopover.visible = value.get_boolean();
            }));
        this._userListPopover.connect('notify::visible', Lang.bind(this,
            function() {
                if (!this._userListPopover.visible)
                    this._userListAction.change_state(GLib.Variant.new('b', false));
            }));

        this._gtkSettings.connect('notify::gtk-decoration-layout',
                                  Lang.bind(this, this._updateDecorations));
        this._updateDecorations();

        this.window.connect('window-state-event',
                            Lang.bind(this, this._onWindowStateEvent));
        this.window.connect('size-allocate',
                            Lang.bind(this, this._onSizeAllocate));
        this.window.connect('delete-event',
                            Lang.bind(this, this._onDelete));

        let size = this._settings.get_value('window-size').deep_unpack();
        if (size.length == 2)
            this.window.set_default_size.apply(this.window, size);

        if (this._settings.get_boolean('window-maximized'))
            this.window.maximize();

        this.window.show_all();
    },

    _onWindowStateEvent: function(widget, event) {
        let state = event.get_window().get_state();

        this._isFullscreen = (state & Gdk.WindowState.FULLSCREEN) != 0;
        this._isMaximized = (state & Gdk.WindowState.MAXIMIZED) != 0;
    },

    _onSizeAllocate: function(widget, allocation) {
        if (!this._isFullscreen && !this._isMaximized)
            this._currentSize = this.window.get_size(this);
    },

    _onDelete: function(widget, event) {
        this._settings.set_boolean ('window-maximized', this._isMaximized);
        this._settings.set_value('window-size',
                                 GLib.Variant.new('ai', this._currentSize));
    },

    _updateDecorations: function() {
        let layoutLeft = null;
        let layoutRight = null;

        let layout = this._gtkSettings.gtk_decoration_layout;
        if (layout) {
            let split = layout.split(':');

            layoutLeft = split[0] + ':';
            layoutRight = ':' + split[1];
        }

        this._titlebarLeft.set_decoration_layout(layoutLeft);
        this._titlebarRight.set_decoration_layout(layoutRight);
    },

    _activeRoomChanged: function(manager, room) {
        if (this._room) {
            this._room.disconnect(this._displayNameChangedId);
            this._room.disconnect(this._topicChangedId);
            this._room.disconnect(this._membersChangedId);
        }
        this._displayNameChangedId = 0;
        this._topicChangedId = 0;
        this._membersChangedId = 0;

        this._room = room;

        this._updateTitlebar();

        if (!this._room)
            return; // finished

        this._displayNameChangedId =
            this._room.connect('notify::display-name',
                               Lang.bind(this, this._updateTitlebar));
        this._topicChangedId =
            this._room.connect('notify::topic',
                               Lang.bind(this, this._updateTitlebar));
        this._membersChangedId =
            this._room.connect('members-changed',
                               Lang.bind(this, this._updateUserListLabel));
    },

    _createWidget: function(app) {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Polari/ui/main-window.ui');

        this.window = builder.get_object('main_window');
        this.window.application = app;

        let overlay = builder.get_object('overlay');
        overlay.add_overlay(app.notificationQueue);
        overlay.add_overlay(app.commandOutputQueue);

        this._titlebarRight = builder.get_object('titlebar_right');
        this._titlebarLeft = builder.get_object('titlebar_left');

        this._titleLabel = builder.get_object('title_label');
        this._subtitleLabel = builder.get_object('subtitle_label');

        this._joinMenuButton = builder.get_object('join_menu_button');
        this._showUserListButton = builder.get_object('show_user_list_button');
        this._userListPopover = builder.get_object('user_list_popover');
        this._revealer = builder.get_object('room_list_revealer');

        // command output notifications should not pop up over
        // the input area, but appear to emerge from it, so
        // set up an appropriate margin
        let roomStack = builder.get_object('room_stack');
        roomStack.bind_property('entry-area-height',
                                app.commandOutputQueue, 'margin-bottom',
                                GObject.BindingFlags.SYNC_CREATE);

        // Make sure user-list button is at least as wide as icon buttons
        this._joinMenuButton.connect('size-allocate', Lang.bind(this,
            function(w, rect) {
                let width = rect.width;
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._showUserListButton.width_request = width;
                    return GLib.SOURCE_REMOVE;
                }));
            }));
    },

    showJoinRoomDialog: function() {
        let dialog = new JoinDialog.JoinDialog({ transient_for: this.window });
        dialog.show();
    },

    showMessageUserDialog: function() {
        let dialog = new MessageDialog.MessageDialog({ transient_for: this.window });
        dialog.show();
    },

    _updateUserListLabel: function() {
        let numMembers = 0;

        if (this._room &&
            this._room.channel &&
            this._room.channel.has_interface(Tp.IFACE_CHANNEL_INTERFACE_GROUP))
            numMembers = this._room.channel.group_dup_members_contacts().length;

        let accessibleName = ngettext("%d user",
                                      "%d users", numMembers).format(numMembers);
        this._showUserListButton.get_accessible().set_name(accessibleName);
        this._showUserListButton.label = '%d'.format(numMembers);
    },

    _updateTitlebar: function() {
        let subtitle = '';
        if (this._room && this._room.topic) {
            let urls = Utils.findUrls(this._room.topic);
            let pos = 0;
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let text = this._room.topic.substr(pos, url.pos - pos);
                let urlText = GLib.markup_escape_text(url.url, -1);
                subtitle += GLib.markup_escape_text(text, -1) +
                            '<a href="%s">%s</a>'.format(urlText, urlText);
                pos = url.pos + url.url.length;
            }
            subtitle += GLib.markup_escape_text(this._room.topic.substr(pos), -1);
        }
        this._subtitleLabel.label = subtitle;
        this._subtitleLabel.visible = subtitle.length > 0;

        this._titleLabel.label = this._room ? this._room.display_name : null;
    }
});
