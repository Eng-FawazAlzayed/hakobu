package app.hakobu.android

import android.app.Application

class HakobuApp : Application() {
    lateinit var hakobu: Hakobu
        private set

    override fun onCreate() {
        super.onCreate()
        hakobu = Hakobu(this)
    }
}

val android.content.Context.hakobu: Hakobu get() = (applicationContext as HakobuApp).hakobu
