<script lang="ts">
	let { active = $bindable() }: { active: boolean } = $props();
</script>


<div class:active class="hamburger"><div></div></div>

<style>
*{
    margin: 0;
    padding: 0;
}


.hamburger{
    position: relative;
    top: 0;
    left: 0;
    height: 3rem;
    width: 3rem;
    padding: 0;
  
  /* FOR DISPLAYING EVERY ELEMENT IN THE CENTER : */
  
    display: flex;
    align-items: center;
    justify-content: center;
}

/* CREATING THE MIDDLE LINE OF THE HAMBURGER : */

.hamburger > div{
    position: relative;
    top: 0;
    left: 0;
    background: var(--color);
    height: 3px;
    width: 60%;
    transition: all  0.4s ease;
}

/* CREATING THE TOP AND BOTTOM LINES : 
TOP AT -10PX ABOVE THE MIDDLE ONE AND BOTTOM ONE IS 10PX BELOW THE MIDDLE: */

.hamburger > div::before,
.hamburger > div::after{
    content: '';
    position: absolute;
    top: -10px;
    background: var(--color);
    width: 100%;
    height: 3px;
    transition: all  0.4s ease;
}

.hamburger > div::after{
    top: 10px;
}

/* IF THE TOGGLER IS IN ITS CHECKED STATE, THEN SETTING THE BACKGROUND OF THE MIDDLE LAYER TO COMPLETE BLACK AND OPAQUE :  */

.active.hamburger > div{
    background: rgba(0,0,0,0);
}

.active.hamburger > div::before{
    top: 0;
    transform: rotate(45deg);
    height: 1px;
}

/* AND ROTATING THE TOP AND BOTTOM LINES :  */

.active.hamburger > div::after{
    top: 0;
    transform: rotate(135deg);
    height: 1px;
}


/* MAIN MENU WITH THE WHITE BACKGROUND AND THE TEXT :  */

.menu{
    background: white;
    width: 0%;
    height: 100vh;
  
  /* APPLYING TRANSITION TO THE MENU :  */
  
    transition: all 0.4s ease;
}

/* IF THE TOGGLER IS CHECKED, THEN INCREASE THE WIDTH OF THE MENU TO 30% , CREATING A SMOOTH EFFECT :  */

.toggler:checked ~ .menu{
    width: 30%;
}


/* STYLING THE LIST :  */

.menu >  div > ul{
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 70px;
    padding-left: 10px;
  
  /* HIDDEN INITIALLY  :  */
  
    visibility: hidden;
}

.menu > div > ul > li{
    list-style: none;
    padding: 0.5rem;
}

.menu > div > ul > li > a{
    color: black;
    text-decoration: none;
    font-size: 2rem;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

/* WHEN THE TOGGLER IS CHECKED, CHANGE THE VISIBILITY TO VISIBLE :  */

.toggler:checked ~ .menu > div > ul{
    transition: visibility 0.4s ease;
    transition-delay: 0.1s;
    visibility: visible;
}

.toggler:checked ~ .menu > div > ul > li > a:hover{
    color: orange;
}
</style>
